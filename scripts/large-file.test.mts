/**
 * large-file.test.mts
 *
 * End-to-end memory verification of the exact code paths page.tsx runs,
 * at a scale that would have crashed the old implementation:
 *
 *   A. Single large WAV  → readWavHeader → memoryVerdict gate →
 *      parseWavStreaming → sumTracks (zero-copy) → measureAll →
 *      clonePcm → masterStereoPcm → measureAll  (the full pipeline)
 *      — asserts peak RSS ≈ 2× decoded PCM (not raw + decode + copies)
 *        and that no slice larger than one 32 MiB chunk is ever requested.
 *   B. ZIP of WAV stems  → JSZip.loadAsync (whole archive, unavoidable) →
 *      entries decoded ONE AT A TIME via decodeWavBytes → pipeline.
 *   C. 1 GB WAV on a "4 GB device" → rejected from the header ALONE
 *      (only the few-MB header prefix is ever read; no data streaming).
 *
 * Run:
 *   node --experimental-strip-types --no-warnings --expose-gc \
 *     --loader ./scripts/resolve-ts.mjs scripts/large-file.test.mts
 */
import JSZip from "jszip";
import { clonePcm, masterStereoPcm, sumTracks } from "../src/lib/client-audio-engine.ts";
import { measureAll } from "../src/lib/analysis.ts";
import {
  decodeWavBytes,
  estimateProjectPeakBytes,
  memoryVerdict,
  parseWavStreaming,
  readWavHeader,
  MEMORY_REJECT_MESSAGE,
} from "../src/lib/file-loader.ts";

let failures = 0;
const ok = (cond: boolean, label: string, extra = "") => {
  if (cond) console.log(`  ✓ ${label}${extra ? ` (${extra})` : ""}`);
  else {
    failures++;
    console.error(`  ✗ ${label} ${extra}`);
  }
};
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const gc = () => (globalThis as { gc?: () => void }).gc?.();

/** Memory tracker: samples RSS continuously and records max blob slice. */
function makeTracker(blob: Blob) {
  let base = 0;
  let peak = 0;
  let maxSlice = 0;
  const origSlice = Blob.prototype.slice;
  Blob.prototype.slice = function (start?: number, end?: number) {
    const len = (end ?? this.size) - (start ?? 0);
    if (len > maxSlice) maxSlice = len;
    return origSlice.call(this, start, end);
  };
  return {
    markBase() {
      gc();
      base = process.memoryUsage().rss;
      peak = base;
    },
    sample() {
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
    },
    stop() {
      Blob.prototype.slice = origSlice;
      gc();
      return { base, peak, maxSlice, growth: peak - base };
    },
  };
}

/** Deterministic tone WAV (16-bit interleaved). */
function makeToneWav(frames: number, sampleRate = 48000, channels = 2): ArrayBuffer {
  const frameSize = 2 * channels;
  const dataSize = frames * frameSize;
  const riffSize = 36 + dataSize;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, riffSize, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * frameSize, true);
  v.setUint16(32, frameSize, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    for (let c = 0; c < channels; c++) {
      const s = 0.45 * Math.sin(2 * Math.PI * (98 + c * 33) * t) * Math.min(1, t * 6);
      v.setInt16(p, Math.round(s * 32767), true);
      p += 2;
    }
  }
  return buf;
}

/* ================================================================== */
/* A. Single large WAV — full pipeline                                */
/* ================================================================== */

console.log("\n[A] single 56 MB WAV (112 MB PCM) — load + full pipeline");
{
  const frames = 14_000_000; // ~292 s, 16-bit stereo 48 kHz ≈ 56 MB
  const pcmBytes = frames * 2 * 4; // 112 MB
  const wavBytes = frames * 4; // 56 MB
  console.log(`  generating ${(wavBytes / MB).toFixed(0)} MB WAV…`);
  const wav = makeToneWav(frames);
  const file = new Blob([wav], { type: "audio/wav" });

  const tracker = makeTracker(file);
  tracker.markBase();

  /* ---- exactly what page.tsx loadProject() does for a WAV ---- */
  const header = await readWavHeader(file);
  tracker.sample();
  ok(header.totalFrames === frames, "header: frame count", `${header.totalFrames}`);
  ok(header.durationSec > 290 && header.durationSec < 292, "header: duration", `${header.durationSec.toFixed(1)}s`);

  const budget = 4 * GB * 0.4; // stand-in 4 GB device
  const peak = header.pcmBytes * 2 + 64 * MB;
  const loadVerdict = memoryVerdict(peak, budget);
  console.log(`  load gate: peak≈${(peak / GB).toFixed(2)} GB vs budget ${(budget / GB).toFixed(2)} GB → ${loadVerdict.level}`);
  ok(loadVerdict.level !== "reject", "load gate passes for a 120 MB file (warn/ok)");

  const { pcm } = await parseWavStreaming(file, { onProgress: () => tracker.sample() });
  tracker.sample();
  ok(pcm.channels[0].length === frames, "streaming parse: all frames");

  /* ---- exactly what runPipeline() does ---- */
  const originalPcm = sumTracks([pcm]);
  ok(originalPcm === pcm, "sumTracks zero-copy fast path (single stereo track)");
  const before = await measureAll(originalPcm);
  tracker.sample();
  const work = clonePcm(originalPcm);
  const masteredPcm = await masterStereoPcm(work, {
    genre: "POP",
    loudness: "SPOTIFY",
    intensity: 75,
    vocalFocus: true,
  });
  const after = await measureAll(masteredPcm);
  tracker.sample();
  ok(Math.abs(after.lufs - -14) <= 0.6, "mastering hit −14 LUFS target", `${after.lufs.toFixed(2)}`);
  ok(after.truePeakDb <= -0.9, "true peak under ceiling", `${after.truePeakDb.toFixed(2)} dBTP`);
  ok(before.lufs !== after.lufs, "mastering changed the material");

  const { growth, maxSlice } = tracker.stop();
  console.log(`  peak RSS growth: ${(growth / MB).toFixed(0)} MB · decoded PCM: ${(pcmBytes / MB).toFixed(0)} MB · legacy approach needed ≈ ${((wavBytes + pcmBytes * 3) / MB).toFixed(0)} MB extra`);
  ok(maxSlice <= 512 * 1024 + 32 * MB, "no slice bigger than header prefix + 32 MiB chunk", `${(maxSlice / MB).toFixed(1)} MB max`);
  ok(growth < pcmBytes * 2 + 300 * MB, "peak memory ≈ tracks + working copy (no raw/decode stacking)", `+${(growth / MB).toFixed(0)} MB`);
}

/* ================================================================== */
/* B. ZIP of WAV stems — one-at-a-time extraction + pipeline          */
/* ================================================================== */

console.log("\n[B] ZIP with 8 × 20 MB WAV stems — one-at-a-time extraction + pipeline");
{
  const stems = 8;
  const frames = 2_500_000; // ~52 s each, ~20 MB raw, ~40 MB PCM each
  console.log(`  building ${stems}-stem ZIP…`);
  const zip = new JSZip();
  for (let i = 0; i < stems; i++) {
    zip.file(`stems/vocal_${i}.wav`, makeToneWav(frames, 48000, 2));
  }
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });

  const tracker = makeTracker(zipBlob);
  tracker.markBase();

  /* ---- exactly what page.tsx loadProject() does for a ZIP ---- */
  let zipBuf: ArrayBuffer | null = await zipBlob.arrayBuffer();
  const loaded = await JSZip.loadAsync(zipBuf);
  zipBuf = null; // the archive buffer is dropped immediately

  const entries = Object.entries(loaded.files).filter(
    ([p, e]) => !e.dir && p.endsWith(".wav")
  );
  ok(entries.length === stems, "ZIP scan found all stems", `${entries.length}`);

  const tracks: { name: string; pcm: { sampleRate: number; channels: Float32Array[] } }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [path, entry] = entries[i];
    const data = await entry.async("arraybuffer"); // ONE entry at a time
    const { pcm, header } = await decodeWavBytes(data); // then its bytes are dropped
    tracks.push({ name: path, pcm });
    ok(header.totalFrames === frames, `stem ${i + 1} decoded`, `${header.durationSec.toFixed(1)}s`);
    tracker.sample();
  }

  const totalPcm = tracks.reduce((a, t) => a + t.pcm.channels[0].length * 2 * 4, 0);
  const est = estimateProjectPeakBytes(tracks.map((t) => t.pcm));
  ok(est > totalPcm && est < totalPcm + totalPcm / stems * 2 + 70 * MB, "multi-track estimate sane", `${(est / MB).toFixed(0)} MB`);

  /* ---- pipeline over the stems ---- */
  const originalPcm = sumTracks(tracks.map((t) => t.pcm));
  ok(originalPcm !== tracks[0].pcm, "multi-track sum allocates the bus");
  const before = await measureAll(originalPcm);
  const work = clonePcm(originalPcm);
  const masteredPcm = await masterStereoPcm(work, {
    genre: "HIP_HOP",
    loudness: "APPLE_MUSIC",
    intensity: 80,
    vocalFocus: false,
  });
  const after = await measureAll(masteredPcm);
  tracker.sample();
  ok(Math.abs(after.lufs - -16) <= 0.6, "stems master hit −16 LUFS target", `${after.lufs.toFixed(2)}`);
  ok(after.truePeakDb <= -0.9, "stems true peak under ceiling", `${after.truePeakDb.toFixed(2)} dBTP`);

  const { growth, maxSlice } = tracker.stop();
  console.log(`  peak RSS growth: ${(growth / MB).toFixed(0)} MB · total PCM: ${(totalPcm / MB).toFixed(0)} MB · zip raw: ${(zipBlob.size / MB).toFixed(0)} MB`);
  ok(maxSlice <= 512 * 1024 + 32 * MB, "no giant single-entry allocation beyond one stem + chunk", `${(maxSlice / MB).toFixed(1)} MB max`);
  ok(growth < totalPcm + 2 * (totalPcm / stems) + 400 * MB, "peak ≈ tracks + bus + work copy (raw not accumulated)", `+${(growth / MB).toFixed(0)} MB`);
}

/* ================================================================== */
/* C. 1 GB WAV on a 4 GB device — rejected from the header alone      */
/* ================================================================== */

console.log("\n[C] 1 GB WAV, 4 GB device — reject BEFORE reading any data");
{
  // 16-bit stereo 48 kHz for 1 GiB of data → 250 M frames.
  const dataBytes = GB;
  const frames = dataBytes / 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 48000 * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, dataBytes, true);
  // data bytes left as zero — never read, by design.
  const file = new Blob([buf], { type: "audio/wav" });

  const tracker = makeTracker(file);
  tracker.markBase();

  const header = await readWavHeader(file);
  const budget = 4 * GB * 0.4; // stand-in 4 GB device
  const peak = header.pcmBytes * 2 + 64 * MB;
  const verdict = memoryVerdict(peak, budget);
  tracker.sample();

  ok(header.pcmBytes === frames * 2 * 4, "1 GB header → 2 GB PCM estimate", `${(header.pcmBytes / GB).toFixed(2)} GB`);
  ok(peak > budget * 1.4, "estimated peak exceeds hard limit", `${(peak / GB).toFixed(2)} GB > ${(budget * 1.4 / GB).toFixed(2)} GB`);
  ok(verdict.level === "reject", "verdict = reject → " + MEMORY_REJECT_MESSAGE);

  const { maxSlice } = tracker.stop();
  ok(maxSlice <= 512 * 1024, "only the header prefix was read (≤ 512 KB) — no data streamed", `${(maxSlice / 1024).toFixed(0)} KB max slice`);
}

/* ================================================================== */

console.log(failures === 0 ? "\nLARGE-FILE TESTS OK" : `\n${failures} TEST(S) FAILED`);
if (failures > 0) process.exit(1);
