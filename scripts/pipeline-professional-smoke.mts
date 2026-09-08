/**
 * Smoke test for the professional stage pipeline (audio-analysis.ts,
 * genre-presets.ts, audio-processors.ts). Runs the whole processAudioClientSide
 * flow on synthetic stems in Node and asserts:
 *   - every stage runs and logs
 *   - per-stem gain staging trims toward -18 dBFS
 *   - the master reaches the loudness target
 *   - QA passes / reports fatal failures when off-target
 */
import { processAudioClientSide, runQA, PIPELINE_STAGES, gainStageStem } from "../src/lib/audio-processors.ts";
import { measureAll } from "../src/lib/analysis.ts";
import type { PcmData } from "../src/lib/client-audio-engine.ts";

function sine(sr: number, seconds: number, freq: number, amp = 0.5, dc = 0): PcmData {
  const n = Math.floor(seconds * sr);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t * 8, (seconds - t) * 8); // fades to avoid clicks
    l[i] = amp * env * Math.sin(2 * Math.PI * freq * t) + dc;
    r[i] = amp * env * Math.sin(2 * Math.PI * freq * t + 0.3) + dc;
  }
  return { sampleRate: sr, channels: [l, r] };
}

const stem = (name: string, freq: number, amp = 0.5) => ({ name, pcm: sine(44100, 1.6, freq, amp) });
const stems = [stem("kick_drum.wav", 60, 0.9), stem("bass.wav", 82, 0.6), stem("vocal.wav", 330, 0.35)];

const logs: string[] = [];
const stages: string[] = [];
let progress = 0;

const t0 = Date.now();
const result = await processAudioClientSide(stems, {
  genre: "HIP_HOP",
  loudness: "SPOTIFY",
  intensity: 70,
  vocalFocus: true,
}, {
  onProgress: (f) => { progress = Math.max(progress, f); },
  onLog: (l) => logs.push(l.text),
  onStage: (s) => { if (s.state !== "pending") stages.push(`${PIPELINE_STAGES[s.id].name}:${s.state}`); },
});

console.log(`progress reached: ${progress.toFixed(2)}`);
console.log("stages:", stages.join(" | "));
console.log("log lines:", logs.length);

// 1. Every stage must complete.
for (const s of PIPELINE_STAGES) {
  if (!stages.includes(`${s.name}:done`)) throw new Error(`stage ${s.name} never completed`);
}

// 2. Gain staging should have trimmed the loud drum stem toward -18 dBFS.
const drumStage = result.gainStage.find((g) => g.name.includes("kick"));
if (!drumStage) throw new Error("no gain-stage entry for kick");
console.log(`kick staging: rms ${drumStage.rmsDb.toFixed(1)} dB -> trim ${drumStage.trimDb.toFixed(1)} dB`);
if (!(drumStage.trimDb < -3)) throw new Error("kick should have been trimmed down");

// 3. Standalone gainStageStem reaches ~ -18 dBFS RMS.
const probe = sine(44100, 0.5, 120, 0.9);
const before = measureRms(probe);
const res = gainStageStem(probe, -18, -3);
const afterRms = measureRms(probe);
console.log(`gainStageStem: ${before.toFixed(1)} dB -> ${afterRms.toFixed(1)} dB (gain ${res.gain.toFixed(2)})`);
if (Math.abs(afterRms - -18) > 0.6) throw new Error(`gain staging did not hit -18 dBFS (got ${afterRms.toFixed(1)})`);

// 4. QA passes & the master hits the target loudness.
console.log("QA:", result.qa.passed, "attempts", result.qaAttempts);
console.log("AFTER:", JSON.stringify(result.after, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));
if (!result.qa.passed) throw new Error(`QA failed: ${result.qa.fatalFailures.join(", ")}`);
if (Math.abs(result.after.lufs - -14) > 0.5) throw new Error(`loudness target missed: ${result.after.lufs}`);
if (result.mastered.channels[0].length !== result.original.channels[0].length) throw new Error("length mismatch");

// 5. runQA fails loudly on an off-target set of metrics.
const bad = runQA({ lufs: -6, truePeakDb: 0.2, dynamicRange: 8, stereoWidth: 2 }, -14);
if (bad.passed) throw new Error("runQA should reject off-target metrics");
if (!bad.fatalFailures.some((f) => f.toLowerCase().includes("lufs"))) throw new Error("expected loudness fatal failure");

// 6. QA notes about dynamic range (synthetic sine is squashed) should warn, not fail.
if (!result.qa.warnings.some((w) => w.toLowerCase().includes("dynamic"))) {
  console.log("note: no dynamic-range warning (acceptable for loud material)");
}

console.log(`\nPROFESSIONAL PIPELINE OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("last logs:");
for (const l of logs.slice(-6)) console.log("  " + l);

function measureRms(pcm: PcmData): number {
  let sum = 0, total = 0;
  for (const ch of pcm.channels) { for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]; total += ch.length; }
  return sum / total > 1e-9 ? 10 * Math.log10(sum / total) : -120;
}
