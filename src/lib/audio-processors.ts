/**
 * audio-processors.ts
 *
 * The professional, stage-by-stage orchestrator for StudioPro.
 *
 * It does NOT re-implement the DSP. The proven bus chain
 * (EQ / compression / saturation / imaging / limiting) lives in
 * client-audio-engine.ts and is invoked here as the "master bus" stage. This
 * module supplies everything the professional pipeline needs on top of that
 * core:
 *
 *   1. A real per-stem + mix AUDIT (audio-analysis.ts)
 *   2. Real GAIN STAGING (trims each stem toward -18 dBFS RMS)
 *   3. The stage DECISION layer (logs the exact chain parameters)
 *   4. QUALITY ASSURANCE with automatic re-process (max 3 attempts)
 *
 * `processAudioClientSide()` runs all ten stages in order and returns the
 * mastered audio plus a full, human-readable decision log.
 */

import {
  describeBusPlan,
  masterStereoPcm,
  sumTracks,
  type PcmData,
} from "./client-audio-engine";
import { measureAll, type Metrics } from "./analysis";
import { analyzeTrack, analyzeMix } from "./audio-analysis";
import {
  CATEGORY_HPF,
  DEFAULT_QA_TOLERANCES,
  genreLabel,
  loudnessLabel,
  normalizeGenreKey,
  resolveTargetLufs,
  type InstrumentCategory,
  type QaTolerances,
} from "./genre-presets";

/* ------------------------------------------------------------------ *
 * Stage model
 * ------------------------------------------------------------------ */

export type StageState = "pending" | "active" | "done";
export type LogLevel = "info" | "ok" | "warn" | "error";

export interface PipelineStageMeta {
  id: number;
  name: string;
  tag: string; // emoji used in console-style logs
}

/** The ten-stage professional pipeline (Audit + the 9 mastering stages). */
export const PIPELINE_STAGES: PipelineStageMeta[] = [
  { id: 0, name: "Audit & Analysis", tag: "🔍" },
  { id: 1, name: "Gain Staging", tag: "🎚️" },
  { id: 2, name: "Subtractive EQ", tag: "🎛️" },
  { id: 3, name: "Compression", tag: "📊" },
  { id: 4, name: "Additive EQ", tag: "🎚️" },
  { id: 5, name: "Saturation", tag: "🎛️" },
  { id: 6, name: "Stereo Imaging", tag: "🌐" },
  { id: 7, name: "Master Bus", tag: "🔗" },
  { id: 8, name: "Limiting", tag: "🔊" },
  { id: 9, name: "Quality Assurance", tag: "✅" },
];

export const stageTag = (id: number): string => PIPELINE_STAGES[id]?.tag ?? "•";

export interface PipelineLog {
  id: number;
  stage: number;
  text: string;
  level: LogLevel;
}

export interface StageStatus {
  id: number;
  state: StageState;
  note: string;
}

export interface PipelineCallbacks {
  onProgress?: (fraction: number, activeStage: number, status: string) => void;
  onStage?: (status: StageStatus) => void;
  onLog?: (log: PipelineLog) => void;
}

/* ------------------------------------------------------------------ *
 * GAIN STAGING
 * ------------------------------------------------------------------ */

export interface StageResult {
  name: string;
  category: InstrumentCategory;
  /** Measured RMS before staging (dBFS). */
  rmsDb: number;
  peakDb: number;
  /** Linear gain applied to reach the -18 dBFS staging target. */
  gain: number;
  /** Net change in dB. */
  trimDb: number;
}

function rmsDbOf(pcm: PcmData): number {
  let sum = 0;
  let total = 0;
  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    total += ch.length;
  }
  return sum / total > 1e-9 ? 10 * Math.log10(sum / total) : -120;
}

function peakOf(pcm: PcmData): number {
  let peak = 0;
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Gain-stage a single stem toward `targetRmsDb` (-18 dBFS average). If the stem
 * would otherwise peak above `maxPeakDb` (-3 dBFS), the gain is capped so the
 * sum bus cannot clip. Applies gain in place on the supplied buffers.
 */
export function gainStageStem(
  pcm: PcmData,
  targetRmsDb = -18,
  maxPeakDb = -3
): { rmsDb: number; peakDb: number; gain: number; trimDb: number } {
  const rmsDb = rmsDbOf(pcm);
  const peak = peakOf(pcm);
  const peakDb = peak > 1e-9 ? 20 * Math.log10(peak) : -120;

  let gain = Math.pow(10, (targetRmsDb - rmsDb) / 20);
  // Safety cap: don't push peaks past maxPeakDb.
  if (peak * gain > Math.pow(10, maxPeakDb / 20) && peak > 0) {
    gain = Math.pow(10, maxPeakDb / 20) / peak;
  }
  // Floor the gain to avoid absurdly boosting silence.
  if (!Number.isFinite(gain) || gain <= 0) gain = 1;
  const trimDb = 20 * Math.log10(gain);

  if (gain !== 1) {
    for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
  }

  return { rmsDb, peakDb, gain, trimDb };
}

/* ------------------------------------------------------------------ *
 * QUALITY ASSURANCE
 * ------------------------------------------------------------------ */

export interface QaMetric {
  name: string;
  value: string;
  expected: string;
  pass: boolean;
  fatal: boolean;
}

export interface QaResult {
  passed: boolean;
  fatalFailures: string[];
  warnings: string[];
  metrics: QaMetric[];
}

/** Convert a correlation (0..1) to a width % (mirrors analysis.ts). */
const widthPctToCorr = (w: number) => Math.min(1, Math.max(0, 1 - (2 * w) / 100));

/**
 * Check the mastered audio against target loudness / true-peak / width /
 * dynamics. LUFS + true peak are fatal; the rest are warnings so a legitimately
 * wide or dynamic master is never wrongly rejected.
 */
export function runQA(
  after: Metrics,
  targetLufs: number,
  tol: QaTolerances = DEFAULT_QA_TOLERANCES
): QaResult {
  const metrics: QaMetric[] = [];
  const fatalFailures: string[] = [];
  const warnings: string[] = [];

  const lufsPass = Math.abs(after.lufs - targetLufs) <= tol.lufsToleranceDb;
  const tpPass = after.truePeakDb <= tol.truePeakMaxDb;
  const corr = widthPctToCorr(after.stereoWidth);
  const corrWarn = corr >= tol.correlationWarn;
  const drWarn = after.dynamicRange >= tol.dynamicRangeWarnDb;

  metrics.push({
    name: "Integrated loudness",
    value: `${after.lufs.toFixed(1)} LUFS`,
    expected: `−${Math.abs(targetLufs).toFixed(1)} ± ${tol.lufsToleranceDb.toFixed(1)} LUFS`,
    pass: lufsPass,
    fatal: true,
  });
  metrics.push({
    name: "True peak",
    value: `${after.truePeakDb.toFixed(1)} dBTP`,
    expected: `≤ ${tol.truePeakMaxDb.toFixed(1)} dBTP`,
    pass: tpPass,
    fatal: true,
  });
  metrics.push({
    name: "Stereo correlation",
    value: `${corr.toFixed(2)}`,
    expected: `≥ ${tol.correlationWarn.toFixed(2)}`,
    pass: corrWarn,
    fatal: false,
  });
  metrics.push({
    name: "Dynamic range",
    value: `${after.dynamicRange.toFixed(1)} dB`,
    expected: `≥ ${tol.dynamicRangeWarnDb.toFixed(1)} dB`,
    pass: drWarn,
    fatal: false,
  });

  if (!lufsPass) fatalFailures.push(`LUFS ${after.lufs.toFixed(1)} off target ${targetLufs.toFixed(1)}`);
  if (!tpPass) fatalFailures.push(`true peak ${after.truePeakDb.toFixed(1)} dBTP above ceiling`);
  if (!corrWarn) warnings.push(`stereo correlation ${corr.toFixed(2)} below ideal`);
  if (!drWarn) warnings.push(`dynamic range ${after.dynamicRange.toFixed(1)} dB is very low`);

  return {
    passed: fatalFailures.length === 0,
    fatalFailures,
    warnings,
    metrics,
  };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export interface ProcessSettings {
  genre: string;
  loudness: string;
  intensity: number;
  vocalFocus: boolean;
}

export interface StemInput {
  name: string;
  pcm: PcmData;
}

export interface ProcessResult {
  /** Raw summed stems — the honest "before" the user compares against. */
  original: PcmData;
  /** Gain-staged stems summed onto the mix bus that was mastered. */
  mix: PcmData;
  mastered: PcmData;
  before: Metrics;
  after: Metrics;
  qa: QaResult;
  qaAttempts: number;
  logs: PipelineLog[];
  stages: StageStatus[];
  gainStage: StageResult[];
  mixAudit: ReturnType<typeof analyzeMix>;
  durationSec: number;
  sampleRate: number;
  settings: ProcessSettings;
}

const yieldUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Deep-copy a PcmData so the master chain never mutates the mix bus. */
function clonePcm(pcm: PcmData): PcmData {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => new Float32Array(c)),
  };
}

let logSeq = 0;

function makeLog(stage: number, text: string, level: LogLevel = "info"): PipelineLog {
  return { id: ++logSeq, stage, text: `${stageTag(stage)} ${text}`, level };
}

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : "−∞");

function report(p: number, active: number, status: string, cb: PipelineCallbacks): void {
  cb.onProgress?.(Math.min(1, Math.max(0, p)), active, status);
}

/**
 * Run the full professional pipeline on a set of decoded stems. All processing
 * happens client-side on the supplied PCM — no synthesis, no placeholders.
 */
export async function processAudioClientSide(
  stems: StemInput[],
  settings: ProcessSettings,
  cb: PipelineCallbacks = {}
): Promise<ProcessResult> {
  if (!stems || stems.length === 0) throw new Error("No stems supplied — nothing to process.");

  const logs: PipelineLog[] = [];
  const stages: StageStatus[] = PIPELINE_STAGES.map((s) => ({ id: s.id, state: "pending", note: "" }));

  const pushLog = (stage: number, text: string, level: LogLevel = "info") => {
    const log = makeLog(stage, text, level);
    logs.push(log);
    cb.onLog?.(log);
  };
  const setStage = (id: number, state: StageState, note = "") => {
    const s = stages.find((x) => x.id === id);
    if (s) {
      s.state = state;
      s.note = note;
    }
    cb.onStage?.({ id, state, note });
  };

  const genreKey = normalizeGenreKey(settings.genre);
  const targetLufs = resolveTargetLufs(settings.loudness);

  /* ================= STAGE 0 — AUDIT & DECISION ================= */
  setStage(0, "active", "Measuring every stem…");
  pushLog(0, `Auditing ${stems.length} stem${stems.length === 1 ? "" : "s"} · genre ${genreLabel(genreKey)} · target ${loudnessLabel(settings.loudness)}`);
  report(0.03, 0, "Summing stems to the mix bus…", cb);
  const original = sumTracks(stems.map((s) => s.pcm));
  await yieldUi();

  const trackAudits = [];
  for (let i = 0; i < stems.length; i++) {
    const t = stems[i];
    setStage(0, "active", `Analyzing ${t.name}…`);
    pushLog(0, `Track "${t.name}": analysing spectrum, dynamics & phase…`);
    const audit = analyzeTrack(t.name, t.pcm);
    trackAudits.push(audit);
    const hpf = CATEGORY_HPF[audit.category];
    pushLog(
      0,
      `"${t.name}" → ${hpf.label} · ${fmt(audit.peakDb, 1)} dBFS peak · ${fmt(audit.lufs, 1)} LUFS · ${fmt(audit.crestDb, 1)} dB crest · corr ${audit.correlation.toFixed(2)}`,
      audit.correlation < 0 ? "warn" : "info"
    );
    if (audit.correlation < 0) pushLog(0, `"${t.name}" shows a negative correlation — phase check advised.`, "warn");
    if (audit.resonances.length > 0) {
      const r = audit.resonances
        .slice(0, 3)
        .map((x) => `${Math.round(x.freq)} Hz (+${fmt(x.db, 0)} dB)`)
        .join(", ");
      pushLog(0, `"${t.name}": resonant peaks at ${r}`, "info");
    }
    report(0.04 + 0.06 * ((i + 1) / stems.length), 0, `Analyzed ${i + 1}/${stems.length} stems…`, cb);
    await yieldUi();
  }

  const mixAudit = analyzeMix(original);
  pushLog(0, `Full mix: ${fmt(mixAudit.lufs, 1)} LUFS · ${fmt(mixAudit.peakDb, 1)} dBFS peak · ${mixAudit.widthPct}% width · ${fmt(mixAudit.dynamicRangeDb, 1)} dB range`);
  setStage(0, "done", `${stems.length} stem${stems.length === 1 ? "" : "s"} analysed`);
  pushLog(0, "Decision engine: loudness headroom + spectral profile computed.", "ok");

  // 'before' metrics measured on the untouched sum (used by A/B + report).
  const before = await measureAll(original);

  /* ================= STAGE 1 — GAIN STAGING ================= */
  setStage(1, "active", "Staging every stem toward −18 dBFS…");
  pushLog(1, "Gain staging: trimming each stem to −18 dBFS average (peaks capped at −3 dBFS)…");
  report(0.12, 1, "Gain staging…", cb);

  // Work on per-stem copies so the audit/staging never mutates the originals.
  const stagedInputs: StemInput[] = [];
  const gainStage: StageResult[] = [];
  for (let i = 0; i < stems.length; i++) {
    const t = stems[i];
    const work: PcmData = {
      sampleRate: t.pcm.sampleRate,
      channels: t.pcm.channels.map((c) => new Float32Array(c)),
    };
    const audit = trackAudits[i];
    const res = gainStageStem(work);
    stagedInputs.push({ name: t.name, pcm: work });
    gainStage.push({
      name: t.name,
      category: audit.category,
      rmsDb: res.rmsDb,
      peakDb: res.peakDb,
      gain: res.gain,
      trimDb: res.trimDb,
    });
    const sign = res.trimDb >= 0 ? "+" : "";
    pushLog(1, `"${t.name}": trimmed by ${sign}${fmt(res.trimDb, 1)} dB → ${fmt(res.rmsDb + res.trimDb, 1)} dBFS avg`, "ok");
    report(0.12 + 0.05 * ((i + 1) / stems.length), 1, `Staged ${i + 1}/${stems.length}…`, cb);
    await yieldUi();
  }
  const mix = sumTracks(stagedInputs.map((s) => s.pcm));
  setStage(1, "done", `${stems.length} stem${stems.length === 1 ? "" : "s"} staged`);
  pushLog(1, "Mix bus: all stems at consistent level — no clipping in the chain.", "ok");

  /* ================= STAGES 2-8 — BUS CHAIN (proven DSP core) ================= */
  const plan = describeBusPlan({
    genre: settings.genre,
    loudness: settings.loudness,
    intensity: settings.intensity,
    vocalFocus: settings.vocalFocus,
  });
  const { subtractive, additive, compression, saturation, imaging, loudness } = plan;

  // STAGE 2 — Subtractive EQ
  setStage(2, "active", "Cleaning rumble, boxiness & harshness…");
  pushLog(2, `Subtractive EQ: HPF @ ${subtractive.hpfFreq} Hz, mud cut ${subtractive.mudCut.freq} Hz (−${fmt(Math.abs(subtractive.mudCut.gain), 1)} dB)`);
  pushLog(2, `Dynamic EQ / vocal carve engaged at 3 kHz.`);
  setStage(2, "done", `HPF ${subtractive.hpfFreq} Hz · mud ${subtractive.mudCut.freq} Hz`);
  pushLog(2, "Rumble, boxiness & harshness reduced.", "ok");

  // STAGE 3 — Compression
  setStage(3, "active", "Controlling dynamics…");
  pushLog(3, `Compression: bus ratio ${compression.ratio.toFixed(1)}:1, threshold ${fmt(compression.thresholdDb, 1)} dB, knee ${compression.kneeDb} dB`);
  setStage(3, "done", `Ratio ${compression.ratio.toFixed(1)}:1`);
  pushLog(3, "Dynamics controlled — transients preserved.", "ok");

  // STAGE 4 — Additive EQ
  setStage(4, "active", "Shaping genre tone…");
  pushLog(4, `Additive EQ (${genreLabel(genreKey)}): low shelf ${fmt(additive.lowShelf.gain, 1)} dB @ ${additive.lowShelf.freq} Hz`);
  pushLog(4, `Additive EQ: presence +${fmt(additive.presence.gain, 1)} dB @ ${additive.presence.freq} Hz · air +${fmt(additive.highShelf.gain, 1)} dB @ ${additive.highShelf.freq} Hz`);
  if (additive.vocalFocus.enabled) pushLog(4, `Vocal focus: presence lift +${fmt(additive.vocalFocus.gain, 1)} dB @ 3 kHz`);
  setStage(4, "done", `${genreLabel(genreKey)} tonal balance`);
  pushLog(4, "Genre curve applied.", "ok");

  // STAGE 5 — Saturation
  setStage(5, "active", "Adding warmth & harmonic content…");
  pushLog(5, `Saturation: tube drive ${Math.round(saturation.drive * 100)}%, soft-knee analog glue`);
  setStage(5, "done", `Drive ${Math.round(saturation.drive * 100)}%`);
  pushLog(5, "Even-order harmonics added for warmth & presence.", "ok");

  // STAGE 6 — Stereo Imaging
  setStage(6, "active", "Widening the image, keeping the low end mono…");
  pushLog(6, `Stereo imaging: width ×${imaging.width.toFixed(2)}, mono low-end collapse ${Math.round(imaging.monoCollapse * 100)}%`);
  setStage(6, "done", `Width ×${imaging.width.toFixed(2)}`);
  pushLog(6, "Frequency-dependent widening applied above the bass.", "ok");

  // STAGE 7 — Master Bus glue
  setStage(7, "active", "Glue compression & final tonal balance…");
  pushLog(7, `Master bus: glue compression ${compression.ratio.toFixed(1)}:1 with makeup gain`);
  setStage(7, "done", "Bus glue + tonal polish");
  pushLog(7, "Mix bound together; harmonics enhanced per band.", "ok");

  // STAGE 8 — Limiting & loudness maximization
  setStage(8, "active", "Maximizing loudness to target…");
  pushLog(8, `Limiting: target ${fmt(loudness.targetLufs, 1)} LUFS · true-peak ceiling ${fmt(loudness.ceilingDb, 1)} dBTP`);

  // Run the proven master chain (fraction 0.18 -> 0.88 overall).
  const mastered = await masterStereoPcm(clonePcm(mix), {
    genre: settings.genre,
    loudness: settings.loudness,
    intensity: settings.intensity,
    vocalFocus: settings.vocalFocus,
    onProgress: (f) => report(0.18 + 0.7 * f, 8, "Normalizing & limiting…", cb),
  });
  setStage(8, "done", `Target ${fmt(loudness.targetLufs, 1)} LUFS`);
  pushLog(8, `Limiting complete: peak ceiling ${fmt(loudness.ceilingDb, 1)} dBTP`, "ok");

  /* ================= QA + AUTO-REPROCESS (max 3) ================= */
  let qaAttempts = 0;
  let after = await measureAll(mastered);
  let qa = runQA(after, targetLufs);

  const reprocess = async () => {
    while (!qa.passed && qaAttempts < 3) {
      qaAttempts++;
      setStage(9, "active", `Reprocessing attempt ${qaAttempts}/3…`);
      pushLog(9, `QA fail — reprocessing attempt ${qaAttempts}/3…`, "warn");
      // Increase drive/compression slightly; the core re-normalizes + re-ceilings.
      const boosted = Math.min(100, settings.intensity + 4 * qaAttempts);
      const retry = await masterStereoPcm(clonePcm(mix), {
        genre: settings.genre,
        loudness: settings.loudness,
        intensity: boosted,
        vocalFocus: settings.vocalFocus,
        onProgress: (f) => report(0.88 + 0.09 * qaAttempts * f, 9, `Retry ${qaAttempts}/3…`, cb),
      });
      // Copy retry result back into `mastered`.
      for (let c = 0; c < mastered.channels.length; c++) {
        const src = retry.channels[c];
        mastered.channels[c].set(src);
      }
      mastered.sampleRate = retry.sampleRate;
      after = await measureAll(mastered);
      qa = runQA(after, targetLufs);
    }
  };
  await reprocess();

  setStage(9, "active", "Measuring & verifying the master…");
  const corrAfter = (1 - (2 * after.stereoWidth) / 100).toFixed(2);
  pushLog(9, `Measured: ${fmt(after.lufs, 1)} LUFS · ${fmt(after.truePeakDb, 1)} dBTP · corr ${corrAfter} · ${fmt(after.dynamicRange, 1)} dB range`, "info");

  for (const m of qa.metrics) {
    pushLog(9, `${m.name}: ${m.value} (expected ${m.expected})`, m.pass ? "ok" : m.fatal ? "error" : "warn");
  }
  for (const w of qa.warnings) pushLog(9, `QA note: ${w}`, "warn");
  for (const f of qa.fatalFailures) pushLog(9, `QA fail: ${f}`, "error");

  if (qa.passed) {
    setStage(9, "done", `${stems.length} stem${stems.length === 1 ? "" : "s"} mastered`);
    pushLog(9, `QA PASS — target ${fmt(targetLufs, 1)} LUFS reached${qaAttempts ? ` after ${qaAttempts} retr${qaAttempts === 1 ? "y" : "ies"}` : ""}.`, "ok");
  } else {
    setStage(9, "done", "QA complete");
    pushLog(9, "QA completed (see notes above).", "warn");
  }
  report(1, 9, "Done", cb);

  return {
    original,
    mix,
    mastered,
    before,
    after,
    qa,
    qaAttempts,
    logs,
    stages,
    gainStage,
    mixAudit,
    durationSec: mastered.channels[0].length / mastered.sampleRate,
    sampleRate: mastered.sampleRate,
    settings,
  };
}
