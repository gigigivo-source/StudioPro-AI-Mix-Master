/**
 * End-to-end smoke test of the automatic plugin engine.
 * Builds five distinct synthetic stems (vocal / drums / bass / synth / guitar),
 * runs processAutoEngine, and checks the acceptance criteria:
 *   - each stem got its category chain with decisions
 *   - master is near the target LUFS (±0.5)
 *   - true peak ≤ -0.2 dBTP
 *   - correlation ≥ 0.7
 *   - reasonable processing time
 */
import { processAutoEngine } from "../src/lib/plugin-orchestrator.ts";
import { measureTruePeak } from "../src/lib/client-audio-engine.ts";
import {
  measureCorrelation,
  measureLUFS,
} from "../src/lib/plugin-analysis.ts";
import { gainToDb } from "../src/lib/plugins/_core.ts";
import type { PcmData } from "../src/lib/client-audio-engine.ts";
import {
  applyChorus,
  applyCompressor,
  applyDeesser,
  applyDelay,
  applyDynamicEQ,
  applyGate,
  applyGain,
  applyHighpass,
  applyLimiter,
  applyLowpass,
  applyMultibandCompressor,
  applyParametricEQ,
  applyReverb,
  applySaturation,
  applyStereoWidener,
  applySubHarmonic,
  applyTransientShaper,
} from "../src/lib/plugins/index.ts";

function makeBuffer(
  freq: number,
  seconds: number,
  sampleRate = 44100,
  stereo = true
): PcmData {
  const length = Math.floor(seconds * sampleRate);
  const l = new Float32Array(length);
  const r = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.max(0, Math.min(1, t * 6, (seconds - t) * 6));
    // A tonal stem + a percussive burst every 0.5s for "drums".
    const burst = (i % Math.floor(sampleRate * 0.5)) < sampleRate * 0.02 ? 1.2 : 0.7;
    const base =
      Math.sin(2 * Math.PI * freq * t) +
      0.35 * Math.sin(2 * Math.PI * freq * 2 * t) +
      0.12 * Math.sin(2 * Math.PI * freq * 0.5 * t) +
      Math.sin(2 * Math.PI * 70 * t) * 0.1;
    const v = env * burst * base;
    l[i] = v * 0.5;
    // Subtle, realistic L/R difference keeps correlation high.
    r[i] = v * 0.5 * (0.9 + 0.2 * Math.sin(2 * Math.PI * freq * t * 0.003));
  }
  return { sampleRate, channels: stereo ? [l, r] : [l] };
}

const t0 = Date.now();

const stems = [
  { name: "lead_vocal.wav", buffer: makeBuffer(420, 8) },
  { name: "drum_loop.wav", buffer: makeBuffer(180, 8) },
  { name: "sub_bass.wav", buffer: makeBuffer(55, 8) },
  { name: "synth_pad.wav", buffer: makeBuffer(330, 8) },
  { name: "elec_guitar.wav", buffer: makeBuffer(240, 8) },
];

const statuses: string[] = [];
const report = await processAutoEngine(stems, {
  genre: "POP",
  loudness: "SPOTIFY",
  intensity: 70,
  vocalFocus: true,
  targetLufs: -14,
  onStatus: (m) => statuses.push(m),
});

// 1. Every stem got the right chain.
console.log("\n— Per-stem chains —");
for (const s of report.stems) {
  console.log(
    `  ${s.name.padEnd(22)} -> ${s.categoryLabel.padEnd(8)} [${s.steps.map((x) => x.name).join(" → ")}]`
  );
}
const expectCats = {
  "lead_vocal.wav": "vocal",
  "drum_loop.wav": "drums",
  "sub_bass.wav": "bass",
  "synth_pad.wav": "synth",
  "elec_guitar.wav": "guitar",
};
for (const s of report.stems) {
  const want = (expectCats as Record<string, string>)[s.name];
  if (!want) throw new Error(`Unexpected stem ${s.name}`);
  if (s.category !== want) throw new Error(`${s.name}: expected ${want}, got ${s.category}`);
}
console.log("  category assignment ✓");

// 2. Master metrics.
const lufs = measureLUFS(report.master);
const tp = gainToDb(measureTruePeak(report.master));
const corr = measureCorrelation(report.master);
console.log(`\n— Master —`);
console.log(`  target -14 LUFS -> ${lufs.toFixed(2)} LUFS (Δ ${Math.abs(lufs + 14).toFixed(2)})`);
console.log(`  true peak ${tp.toFixed(2)} dBTP (must be ≤ -0.2)`);
console.log(`  correlation ${corr.toFixed(3)} (must be ≥ 0.7)`);
console.log(`  QA attempt ${report.qa.attempt} passed=${report.qa.passed}`);

if (Math.abs(lufs + 14) > 0.5) throw new Error(`LUFS miss: ${lufs}`);
if (tp > -0.2) throw new Error(`true peak too hot: ${tp}`);
if (corr < 0.7) throw new Error(`correlation too low: ${corr}`);

// Master bus chain present.
console.log(`  master bus steps: ${report.masterSteps.map((s) => s.name).join(" → ")}`);
if (!report.masterSteps.some((s) => s.name === "Glue Compressor")) throw new Error("missing glue");
if (!report.masterSteps.some((s) => s.name === "True-Peak Limiter")) throw new Error("missing limiter");

const elapsed = (Date.now() - t0) / 1000;
console.log(`\nAUTO PLUGIN ENGINE OK in ${elapsed.toFixed(2)}s (${statuses.length} status updates)`);

/* ------------------------------------------------------------------ */
/* Probe: verify QA auto-reprocess fires when a metric fails.          */
/* Feed deliberately over-wide, decorrelated material; the engine must */
/* detect low correlation and reprocess with reduced width (≥2 passes).*/
/* ------------------------------------------------------------------ */

function makeDeco(freq: number, seconds = 8, sr = 44100): PcmData {
  const length = Math.floor(seconds * sr);
  const l = new Float32Array(length);
  const r = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.max(0, Math.min(1, t * 8, (seconds - t) * 8));
    l[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
    r[i] = Math.sin(2 * Math.PI * freq * 2.7 * t + 1.3) * env * 0.5;
  }
  return { sampleRate: sr, channels: [l, r] };
}

const repro = await processAutoEngine(
  [{ name: "wide_stereo_lead.wav", buffer: makeDeco(300) }],
  {
    genre: "POP",
    loudness: "SPOTIFY",
    intensity: 60,
    vocalFocus: false,
    targetLufs: -14,
  }
);
console.log(
  `\nReprocess probe: attempts=${repro.qaAttempts.length}, passed=${repro.qa.passed}, warnings=${repro.warnings.length}`
);
if (repro.qaAttempts.length < 2) {
  throw new Error("QA auto-reprocess did not trigger on failing metrics");
}
console.log("QA auto-reprocess verified ✓");

/* ------------------------------------------------------------------ */
/* Sweep: run EVERY plugin on a small buffer to confirm none crash and */
/* all output finite (NaN/Inf checks).                                */
/* ------------------------------------------------------------------ */

const probe = makeBuffer(220, 2, 44100);
const fns: Array<[string, (b: PcmData) => PcmData]> = [
  ["gain", (b) => applyGain(b, -3)],
  ["highpass", (b) => applyHighpass(b, 90)],
  ["lowpass", (b) => applyLowpass(b, 9000)],
  ["parametricEQ", (b) => applyParametricEQ(b, 2000, 3, 1, "bell")],
  ["dynamicEQ", (b) => applyDynamicEQ(b, 2500, 3, -30, 1)],
  ["compressor", (b) => applyCompressor(b, -20, 3, 0.005, 0.05, 3)],
  ["multibandCompressor", (b) =>
    applyMultibandCompressor(b, { low: { threshold: -20, ratio: 4 }, mid: { threshold: -24, ratio: 2 }, high: { threshold: -28, ratio: 1.5 } })],
  ["deesser", (b) => applyDeesser(b, -25, 7000)],
  ["transientShaper", (b) => applyTransientShaper(b, 1.3, 0.8)],
  ["saturation", (b) => applySaturation(b, 0.4, "tape")],
  ["saturation(tube)", (b) => applySaturation(b, 0.4, "tube")],
  ["stereoWidener", (b) => applyStereoWidener(b, 1.3)],
  ["reverb", (b) => applyReverb(b, 1.5, 0.2)],
  ["delay", (b) => applyDelay(b, 0.25, 0.2, 0.1)],
  ["gate", (b) => applyGate(b, -40, 0.001, 0.05)],
  ["limiter", (b) => applyLimiter(b, -0.5, -1, 0.005)],
  ["subHarmonic", (b) => applySubHarmonic(b, 60, 0.2)],
  ["chorus", (b) => applyChorus(b, 0.5, 0.5, 0.3)],
];
for (const [name, fn] of fns) {
  const out = fn({ sampleRate: probe.sampleRate, channels: probe.channels.map((c) => new Float32Array(c)) });
  for (const ch of out.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (!Number.isFinite(ch[i])) throw new Error(`${name} produced non-finite sample at ${i}`);
    }
  }
}
console.log(`\nPlugin sweep: ${fns.length} plugin calls OK (all outputs finite)`);

console.log(`\nALL AUTO-ENGINE CHECKS PASSED in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
