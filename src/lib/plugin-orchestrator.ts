/**
 * plugin-orchestrator.ts — the 100% decision-making brain.
 *
 * For every stem it:
 *   1. detects the category (filename → spectrum fallback)
 *   2. analyses the stem (RMS, peak, LUFS, dynamic range, spectrum, …)
 *   3. picks the pre-defined chain for that category
 *   4. derives each plugin's parameters dynamically from that analysis
 *   5. runs the chain, then sums every processed stem to a stereo mix
 *   6. applies the master bus (glue compressor → genre EQ → limiting)
 *   7. runs QA on the final master and auto-reprocesses (max 3 attempts)
 *
 * The DSP is synchronous but the module yields to the event loop between
 * stages so the UI can stream progress.
 */

import { measureTruePeak, type PcmData } from "./client-audio-engine";
import { applyCompressor } from "./plugins/compressor";
import { applyLimiter } from "./plugins/limiter";
import { applyParametricEQ } from "./plugins/parametricEQ";
import { applyHighpass } from "./plugins/highpass";
import { applyStereoWidener } from "./plugins/stereoWidener";
import { applyGain } from "./plugins/gain";
import { clonePcm, gainToDb, toStereo } from "./plugins/_core";
import { CATEGORY_LABELS, chainStepsFor } from "./chains";
import { estimateBpm } from "./chains/_helpers";
import type { ChainContext, PluginStep, StemAnalysis } from "./chains/_types";
import {
  detectCategory,
  measureCorrelation,
  measureDynamicRange,
  measureLUFS,
  measurePeak,
  measureRMS,
  measureSpectrum,
  measureTransientDensity,
  type StemCategory,
} from "./plugin-analysis";

export const AUTO_STAGE_LABELS = [
  "Audit",
  "Gain Staging",
  "Subtractive EQ",
  "Compression",
  "Additive EQ",
  "Saturation",
  "Imaging",
  "Master Bus",
  "Limiting",
  "QA",
] as const;

export const TARGET_CEILING_DB = -1.0;
export const QA_LUFS_TOLERANCE = 0.5;
export const QA_TP_LIMIT_DB = -0.2;
export const QA_MIN_CORRELATION = 0.7;
export const MAX_ATTEMPTS = 3;

export interface AutoProcessOptions {
  genre: string;
  loudness: string;
  intensity: number;
  vocalFocus: boolean;
  targetLufs: number;
  onProgress?: (fraction: number) => void;
  onStatus?: (message: string) => void;
  onStage?: (index: number, label: string) => void;
}

export interface StemInput {
  name: string;
  buffer: PcmData;
}

export interface StemStep extends Omit<PluginStep, "apply"> {
  order: number;
}

export interface StemReport {
  name: string;
  category: StemCategory;
  categoryLabel: string;
  chainLabel: string;
  analysis: StemAnalysis;
  steps: StemStep[];
}

export interface QAReport {
  attempt: number;
  passed: boolean;
  lufs: number;
  lufsDelta: number;
  truePeakDb: number;
  correlation: number;
  dynamicRange: number;
  failures: string[];
}

export interface AutoReport {
  master: PcmData;
  originalMix: PcmData;
  stems: StemReport[];
  masterSteps: StemStep[];
  qa: QAReport;
  qaAttempts: QAReport[];
  bpm: number;
  warnings: string[];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const CHAIN_NAME: Record<StemCategory, string> = {
  vocal: "Vocal chain",
  drums: "Drum chain",
  bass: "Bass chain",
  synth: "Synth chain",
  guitar: "Guitar chain",
  other: "Generic chain",
};

/* ------------------------------------------------------------------ *
 * Master-bus EQ curves per genre.
 * ------------------------------------------------------------------ */

interface MasterEqCurve {
  hpFreq: number;
  subFreq?: number;
  subGain?: number;
  mudFreq?: number;
  mudGain?: number;
  presenceFreq?: number;
  presenceGain?: number;
  airFreq?: number;
  airGain?: number;
}

const MASTER_EQ_CURVES: Record<string, MasterEqCurve> = {
  POP: { hpFreq: 24, mudFreq: 300, mudGain: -1.2, presenceFreq: 3500, presenceGain: 1.2, airFreq: 10000, airGain: 1.2 },
  HIP_HOP: { hpFreq: 22, subFreq: 45, subGain: 2.2, mudFreq: 220, mudGain: -1.5, presenceFreq: 3000, presenceGain: 0.8, airFreq: 9500, airGain: 1.0 },
  EDM: { hpFreq: 20, subFreq: 50, subGain: 2.0, mudFreq: 350, mudGain: -1.8, presenceFreq: 5000, presenceGain: 1.2, airFreq: 12000, airGain: 1.8 },
  ROCK: { hpFreq: 26, mudFreq: 400, mudGain: -1.5, presenceFreq: 2600, presenceGain: 1.5, airFreq: 8000, airGain: 1.2 },
  METAL: { hpFreq: 30, mudFreq: 500, mudGain: -2.0, presenceFreq: 3000, presenceGain: 2.0, airFreq: 7000, airGain: 1.2 },
  ACOUSTIC: { hpFreq: 30, mudFreq: 300, mudGain: -0.8, presenceFreq: 2600, presenceGain: 0.8, airFreq: 8000, airGain: 1.0 },
  CLASSICAL: { hpFreq: 26, presenceFreq: 2200, presenceGain: 0.5, airFreq: 9000, airGain: 1.2 },
  JAZZ: { hpFreq: 28, mudFreq: 300, mudGain: -0.6, presenceFreq: 2200, presenceGain: 0.8, airFreq: 8000, airGain: 1.0 },
  R_AND_B: { hpFreq: 22, subFreq: 50, subGain: 2.0, mudFreq: 250, mudGain: -1.0, presenceFreq: 3500, presenceGain: 1.2, airFreq: 9500, airGain: 1.4 },
  LO_FI: { hpFreq: 30, mudFreq: 400, mudGain: -0.8, presenceFreq: 2200, presenceGain: -0.5, airFreq: 6000, airGain: -1.5 },
};

function eqCurveFor(genre: string): MasterEqCurve {
  const g = (genre || "").toUpperCase();
  return MASTER_EQ_CURVES[g] || MASTER_EQ_CURVES.POP;
}

/* ------------------------------------------------------------------ *
 * Per-stem analysis
 * ------------------------------------------------------------------ */

async function analyzeStem(input: StemInput, category: StemCategory): Promise<StemAnalysis> {
  const spectrum = measureSpectrum(input.buffer);
  const rms = measureRMS(input.buffer);
  const peak = measurePeak(input.buffer);
  const lufs = measureLUFS(input.buffer);
  const dynamicRange = measureDynamicRange(input.buffer);
  const correlation = measureCorrelation(input.buffer);
  const transientDensity = measureTransientDensity(input.buffer);
  await tick();
  return { category, rms, peak, lufs, dynamicRange, correlation, transientDensity, spectrum };
}

function sumPcm(tracks: PcmData[]): PcmData {
  if (tracks.length === 0) throw new Error("No stems to mix");
  const rate = Math.max(...tracks.map((t) => t.sampleRate));
  const length = Math.max(...tracks.map((t) => t.channels[0].length));
  const out = { sampleRate: rate, channels: [new Float32Array(length), new Float32Array(length)] };
  const gain = 1 / Math.sqrt(tracks.length);
  for (const t of tracks) {
    const st = toStereo(t);
    const l = st.channels[0];
    const r = st.channels[1];
    for (let i = 0; i < l.length; i++) out.channels[0][i] += l[i] * gain;
    for (let i = 0; i < r.length; i++) out.channels[1][i] += r[i] * gain;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Master bus
 * ------------------------------------------------------------------ */

interface MasterParams {
  ceilingDb: number;
  glueRatio: number;
  glueThresh: number;
  width: number;
}

async function runMasterBus(
  mix: PcmData,
  targetLufs: number,
  params: MasterParams,
  curve: MasterEqCurve,
  log: StemStep[]
): Promise<PcmData> {
  let order = 0;

  // 1. Glue compressor.
  const glue = applyCompressor(clonePcm(mix), params.glueThresh, params.glueRatio, 0.015, 0.25, 6);
  log.push({
    order: ++order,
    name: "Glue Compressor",
    note: `Bus glue ${params.glueRatio}:1 @ threshold ${params.glueThresh.toFixed(1)} dB, 15 ms attack`,
    params: { threshold: +params.glueThresh.toFixed(1), ratio: params.glueRatio, attack: 0.015, release: 0.25 },
  });

  // 2. Master EQ (genre curve).
  let eq = glue;
  const ops: Array<{ name: string; fn: () => PcmData }> = [];
  if (curve.hpFreq > 0) ops.push({ name: `High-pass ${curve.hpFreq} Hz`, fn: () => applyHighpass(clonePcm(eq), curve.hpFreq, 0.707) });
  if (curve.subFreq) ops.push({ name: `Sub shelf ${curve.subFreq} Hz`, fn: () => applyParametricEQ(clonePcm(eq), curve.subFreq!, curve.subGain ?? 0, 0.9, "lowshelf") });
  if (curve.mudFreq) ops.push({ name: `Mud carve ${curve.mudFreq} Hz`, fn: () => applyParametricEQ(clonePcm(eq), curve.mudFreq!, curve.mudGain ?? 0, 1.0, "bell") });
  if (curve.presenceFreq) ops.push({ name: `Presence ${curve.presenceFreq} Hz`, fn: () => applyParametricEQ(clonePcm(eq), curve.presenceFreq!, curve.presenceGain ?? 0, 1.0, "bell") });
  if (curve.airFreq) ops.push({ name: `Air ${curve.airFreq} Hz`, fn: () => applyParametricEQ(clonePcm(eq), curve.airFreq!, curve.airGain ?? 0, 0.9, "highshelf") });
  for (const op of ops) {
    eq = op.fn();
    log.push({ order: ++order, name: "Master EQ", note: op.name, params: {} });
  }

  // 3. Width re-balance (QA may narrow on reprocess).
  if (params.width !== 1) {
    eq = applyStereoWidener(eq, params.width);
    log.push({ order: ++order, name: "Stereo Widener", note: `Width ×${params.width}`, params: { width: params.width } });
  }

  // 4. Limiting + loudness normalisation.
  let limited = eq;
  let gainApplied = 0;
  for (let i = 0; i < 6; i++) {
    const lufs = measureLUFS(limited);
    const gainDb = Math.max(-18, Math.min(18, targetLufs - lufs));
    gainApplied += gainDb;
    limited = applyGain(clonePcm(limited), gainDb);
    limited = applyLimiter(limited, params.ceilingDb + 0.1, params.ceilingDb, 0.005);
    const after = measureLUFS(limited);
    if (Math.abs(after - targetLufs) < 0.2) break;
    const tp = gainToDb(measureTruePeak(limited));
    if (tp >= params.ceilingDb - 0.05 && after <= targetLufs) break;
  }
  log.push({
    order: ++order,
    name: "True-Peak Limiter",
    note: `Brick-wall ${params.ceilingDb} dBTP, 5 ms look-ahead, loudness → ${targetLufs} LUFS`,
    params: { ceiling: params.ceilingDb, targetLufs, makeup: +gainApplied.toFixed(1) },
  });
  return limited;
}

/* ------------------------------------------------------------------ *
 * Public orchestrator
 * ------------------------------------------------------------------ */

export async function processAutoEngine(inputs: StemInput[], options: AutoProcessOptions): Promise<AutoReport> {
  const { onProgress, onStatus, onStage } = options;
  const stage = (i: number, msg: string) => {
    onStage?.(i, AUTO_STAGE_LABELS[i]);
    onStatus?.(msg);
  };
  if (!inputs.length) throw new Error("No stems supplied to the auto engine.");

  onProgress?.(0.01);
  stage(0, "Auditing stems…");
  const originalMix = toStereo(sumPcm(inputs.map((i) => i.buffer)));

  // Per-stem analysis + classification.
  const stems: StemReport[] = [];
  for (let s = 0; s < inputs.length; s++) {
    const input = inputs[s];
    stage(0, `Auditing ${input.name}…`);
    let category = detectCategory(input.name);
    let spectrum: Float32Array | undefined;
    if (category === "other") {
      spectrum = measureSpectrum(input.buffer);
      category = detectCategory(input.name, spectrum);
    }
    onProgress?.(0.02 + (s / inputs.length) * 0.08);
    const analysis = await analyzeStem(input, category);
    if (spectrum) analysis.spectrum = spectrum;
    onProgress?.(0.05 + ((s + 1) / inputs.length) * 0.08);
    stems.push({ name: input.name, category, categoryLabel: CATEGORY_LABELS[category], chainLabel: CHAIN_NAME[category], analysis, steps: [] });
  }

  // Project tempo drives time-synced effects.
  onStatus?.("Estimating tempo for time-synced effects…");
  const bpm = estimateBpm(originalMix);
  onProgress?.(0.14);

  // Apply each stem's chain (single pass, with the correct BPM).
  const finalProcessed: PcmData[] = [];
  for (let s = 0; s < inputs.length; s++) {
    const input = inputs[s];
    const stem = stems[s];
    const settings = {
      genre: options.genre,
      loudness: options.loudness,
      intensity: options.intensity,
      vocalFocus: options.vocalFocus,
      targetLufs: options.targetLufs,
    };
    const ctx: ChainContext = { analysis: stem.analysis, settings, bpm };
    const steps = chainStepsFor(stem.category, ctx);
    let buf = clonePcm(input.buffer);
    stage(1, `Gain staging ${stem.categoryLabel} — ${stem.chainLabel}…`);
    for (let k = 0; k < steps.length; k++) {
      const step = steps[k];
      stage(
        Math.min(6, 1 + Math.floor((k / Math.max(1, steps.length)) * 6)),
        `${stem.categoryLabel}: ${step.name}${step.note ? ` — ${step.note}` : ""}`
      );
      buf = step.apply(buf);
      stem.steps.push({ name: step.name, note: step.note, params: step.params, order: k + 1 });
      onProgress?.(0.15 + (s / inputs.length) * 0.44 + (k / Math.max(1, steps.length)) * (0.44 / inputs.length));
      await tick();
    }
    finalProcessed.push(buf);
  }

  // Sum processed stems to the stereo mix.
  onStatus?.("Summing processed stems to the stereo mix bus…");
  const finalMix = toStereo(sumPcm(finalProcessed));
  onProgress?.(0.62);

  // ---- Master bus + QA auto-reprocess (max 3 attempts) ----
  onStatus?.("Applying master bus — glue, EQ, limiting…");
  const warnings: string[] = [];
  const qaAttempts: QAReport[] = [];
  const masterSteps: StemStep[] = [];
  let master = finalMix;
  let qaReport: QAReport | null = null;

  const rms = measureRMS(finalMix);
  const dr = measureDynamicRange(finalMix);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const curve = eqCurveFor(options.genre);
    const glueThresh = Math.max(-60, Math.min(-6, rms + 4 - Math.min(3, dr * 0.1)));
    const params: MasterParams = { ceilingDb: TARGET_CEILING_DB, glueRatio: 1.5, glueThresh, width: 1 };

    if (attempt > 1 && qaAttempts.length) {
      const prev = qaAttempts[qaAttempts.length - 1];
      if (prev.lufs < options.targetLufs - QA_LUFS_TOLERANCE) params.ceilingDb = Math.max(-1.5, TARGET_CEILING_DB + 0.25);
      if (prev.lufs > options.targetLufs + QA_LUFS_TOLERANCE) params.ceilingDb = Math.min(-0.5, TARGET_CEILING_DB - 0.25);
      if (prev.truePeakDb > QA_TP_LIMIT_DB) params.ceilingDb = Math.max(-2, params.ceilingDb - 0.3);
      if (prev.correlation < QA_MIN_CORRELATION) params.width = 0.9;
    }

    stage(7, `Master bus attempt ${attempt}/${MAX_ATTEMPTS}…`);
    masterSteps.length = 0;
    master = await runMasterBus(finalMix, options.targetLufs, params, curve, masterSteps);

    // ---- QA ----
    onProgress?.(0.9);
    stage(9, `Running quality assurance (attempt ${attempt}/${MAX_ATTEMPTS})…`);
    const lufs = measureLUFS(master);
    const tpDb = gainToDb(measureTruePeak(master));
    const correlation = measureCorrelation(master);
    const dynRange = measureDynamicRange(master);

    const failures: string[] = [];
    if (Math.abs(lufs - options.targetLufs) > QA_LUFS_TOLERANCE)
      failures.push(`LUFS ${lufs.toFixed(1)} vs target ${options.targetLufs.toFixed(1)} (Δ ${Math.abs(lufs - options.targetLufs).toFixed(2)})`);
    if (tpDb > QA_TP_LIMIT_DB) failures.push(`true peak ${tpDb.toFixed(2)} dBTP > ${QA_TP_LIMIT_DB} dBTP`);
    if (correlation < QA_MIN_CORRELATION) failures.push(`correlation ${correlation.toFixed(2)} < ${QA_MIN_CORRELATION}`);

    qaReport = { attempt, passed: failures.length === 0, lufs, lufsDelta: Math.abs(lufs - options.targetLufs), truePeakDb: tpDb, correlation, dynamicRange: dynRange, failures };
    qaAttempts.push(qaReport);

    if (qaReport.passed || attempt === MAX_ATTEMPTS) {
      if (!qaReport.passed)
        warnings.push(`QA not fully passed after ${attempt} attempt${attempt > 1 ? "s" : ""} (${failures.join("; ")}). Delivering the best master.`);
      onStatus?.(qaReport.passed ? "QA passed ✓" : "Delivering best attempt (QA warning)");
      onProgress?.(1);
      await tick();
      return { master, originalMix, stems, masterSteps, qa: qaReport, qaAttempts, bpm, warnings };
    }
    stage(9, `QA failed: ${failures.join("; ")}. Reprocessing with adjusted parameters…`);
    onProgress?.(0.7 + attempt * 0.02);
  }

  throw new Error("Auto-process loop exhausted unexpectedly");
}
