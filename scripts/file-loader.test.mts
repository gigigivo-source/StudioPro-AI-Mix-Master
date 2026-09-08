/**
 * file-loader.test.mts
 *
 * Node-based tests for the memory-safe file loading path (run with plain
 * Node type-stripping, like pipeline-smoke.mts):
 *
 *   node --experimental-strip-types --no-warnings --expose-gc \
 *     --loader ./scripts/resolve-ts.mjs scripts/file-loader.test.mts
 *
 * Covers:
 *  - streaming parser correctness vs the reference parseWav (8/16/24/32-int/
 *    32-float/64-float, mono→5.1, ID3v2 prefix, large LIST chunk, padded
 *    data chunk) — bit-exact,
 *  - decodeWavBytes (ZIP-entry path) matches the streaming parser,
 *  - PROOF OF STREAMING: no blob slice larger than the 32 MiB chunk is ever
 *    requested from a large file (a full-file arrayBuffer would show up as a
 *    full-size slice),
 *  - RSS growth on a 400 MB WAV ≈ decoded PCM only (not raw + PCM),
 *  - computePeaks caps at 2000 / sane values,
 *  - buildPreviewWav emits 22.05 kHz / 16-bit stereo,
 *  - memoryVerdict / estimateProjectPeakBytes decision logic.
 */
import { parseWav } from "../src/lib/client-audio-engine.ts";
import {
  buildPreviewWav,
  computePeaks,
  decodeWavBytes,
  estimateProjectPeakBytes,
  memoryVerdict,
  MAX_WAVEFORM_PEAKS,
  parseWavStreaming,
  readWavHeader,
} from "../src/lib/file-loader.ts";

let failures = 0;
const ok = (cond: boolean, label: string, extra = "") => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label} ${extra}`);
  }
};
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ */
/* WAV generator                                                       */
/* ------------------------------------------------------------------ */

interface WavOpts {
  channels: number;
  sampleRate: number;
  bits: number; // 8 | 16 | 24 | 32 | 64
  format: number; // 1 = PCM int, 3 = IEEE float
  frames: number;
  listChunk?: number; // size of a junk LIST chunk between fmt and data
  id3?: boolean; // prepend an ID3v2 tag
  padData?: number; // pad the data chunk's size field by N bytes
}

function quantize(v: number, bits: number, format: number): number {
  if (format === 3) return v; // stored as float (rounded by the writer)
  if (bits === 8) return Math.max(0, Math.min(255, Math.round((v + 1) * 127)));
  if (bits === 16) return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  if (bits === 24) return Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
  if (bits === 32) return Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483647)));
  throw new Error("bad bits");
}

function makeWav(o: WavOpts): ArrayBuffer {
  const { channels, sampleRate, bits, format, frames } = o;
  const bytesPerSample = bits / 8;
  const frameSize = bytesPerSample * channels;
  const listSize = o.listChunk ?? 0;
  const dataSize = frames * frameSize + (o.padData ?? 0);
  const id3Size = o.id3 ? 10 + 4 : 0;
  const riffSize = 4 + (8 + 16) + (listSize ? 8 + listSize : 0) + 8 + dataSize;
  const total = id3Size + 8 + riffSize + 4;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let p = 0;

  const tag = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (x: number) => (v.setUint32(p, x >>> 0, true), (p += 4));
  const u16 = (x: number) => (v.setUint16(p, x, true), (p += 2));

  if (o.id3) {
    tag("ID3");
    v.setUint8(p++, 3); // version major
    v.setUint8(p++, 0); // version revision
    v.setUint8(p++, 0); // flags
    v.setUint8(p++, 0); // sync-safe size bytes
    v.setUint8(p++, 0);
    v.setUint8(p++, 0);
    v.setUint8(p++, 4); // size = 4
    p += 4; // 4 bytes of tag content
  }

  tag("RIFF");
  u32(riffSize);
  tag("WAVE");
  tag("fmt ");
  u32(16);
  u16(format);
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * frameSize);
  u16(frameSize);
  u16(bits);
  if (listSize > 0) {
    tag("LIST");
    u32(listSize);
    tag("info");
    p += listSize - 4; // junk
  }
  tag("data");
  u32(dataSize);
  // Interleaved frames: a deterministic "tone" per channel.
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    for (let c = 0; c < channels; c++) {
      const s = 0.6 * Math.sin(2 * Math.PI * (110 + c * 44) * t) * Math.min(1, t * 8);
      const q = quantize(s, bits, format);
      if (format === 3) {
        if (bits === 32) v.setFloat32(p, q, true), (p += 4);
        else v.setFloat64(p, q, true), (p += 8);
      } else if (bits === 8) v.setUint8(p, q), (p += 1);
      else if (bits === 16) v.setInt16(p, q, true), (p += 2);
      else if (bits === 24) {
        let x = q;
        v.setUint8(p++, x & 0xff);
        v.setUint8(p++, (x >> 8) & 0xff);
        v.setUint8(p++, (x >> 16) & 0xff);
      } else if (bits === 32) v.setInt32(p, q, true), (p += 4);
    }
  }
  return buf;
}

/** Reference samples: what the WAV bytes *mean* (dequantized by the engine). */
const refPcm = (buf: ArrayBuffer) => parseWav(buf);

function pcmEqual(a: { sampleRate: number; channels: Float32Array[] }, b: { sampleRate: number; channels: Float32Array[] }, label: string, exact = true) {
  ok(a.sampleRate === b.sampleRate, `${label}: sample rate`, `${a.sampleRate} vs ${b.sampleRate}`);
  ok(a.channels.length === b.channels.length, `${label}: channel count`, `${a.channels.length} vs ${b.channels.length}`);
  let maxDiff = 0;
  for (let c = 0; c < Math.min(a.channels.length, b.channels.length); c++) {
    const x = a.channels[c];
    const y = b.channels[c];
    ok(x.length === y.length, `${label}: ch${c} length`, `${x.length} vs ${y.length}`);
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i]);
      if (d > maxDiff) maxDiff = d;
    }
  }
  ok(exact ? maxDiff === 0 : maxDiff <= 1e-6, `${label}: samples match`, `maxDiff=${maxDiff}`);
}

/* ------------------------------------------------------------------ */
/* 1. Parser correctness across formats                               */
/* ------------------------------------------------------------------ */

console.log("\n[1] streaming parser correctness (vs reference parseWav)");
const cases: { label: string; opts: WavOpts }[] = [
  { label: "16-bit stereo 44.1k", opts: { channels: 2, sampleRate: 44100, bits: 16, format: 1, frames: 44100 } },
  { label: "16-bit mono 48k", opts: { channels: 1, sampleRate: 48000, bits: 16, format: 1, frames: 48000 } },
  { label: "24-bit stereo 48k", opts: { channels: 2, sampleRate: 48000, bits: 24, format: 1, frames: 48000 } },
  { label: "32-bit int stereo", opts: { channels: 2, sampleRate: 44100, bits: 32, format: 1, frames: 44100 } },
  { label: "32-bit float stereo", opts: { channels: 2, sampleRate: 44100, bits: 32, format: 3, frames: 44100 } },
  { label: "64-bit float mono", opts: { channels: 1, sampleRate: 48000, bits: 64, format: 3, frames: 48000 } },
  { label: "8-bit mono", opts: { channels: 1, sampleRate: 22050, bits: 8, format: 1, frames: 22050 } },
  { label: "5.1 16-bit", opts: { channels: 6, sampleRate: 48000, bits: 16, format: 1, frames: 24000 } },
  { label: "ID3v2 prefix", opts: { channels: 2, sampleRate: 44100, bits: 16, format: 1, frames: 22050, id3: true } },
  { label: "1 MB LIST chunk", opts: { channels: 2, sampleRate: 44100, bits: 16, format: 1, frames: 22050, listChunk: 1024 * 1024 } },
  { label: "padded data chunk", opts: { channels: 2, sampleRate: 44100, bits: 16, format: 1, frames: 22050, padData: 512 } },
  { label: "tiny (100 frames)", opts: { channels: 2, sampleRate: 44100, bits: 16, format: 1, frames: 100 } },
];

for (const { label, opts } of cases) {
  const raw = makeWav(opts);
  const ref = refPcm(raw);
  const blob = new Blob([raw]);
  const streamed = await parseWavStreaming(blob);
  pcmEqual(streamed.pcm, ref, label);
  ok(approx(streamed.header.durationSec, ref.channels[0].length / ref.sampleRate, 1e-9), `${label}: header duration`);

  const fromBytes = await decodeWavBytes(raw);
  pcmEqual(fromBytes.pcm, ref, label + " (decodeWavBytes)");
}

/* ------------------------------------------------------------------ */
/* 2. Error handling                                                  */
/* ------------------------------------------------------------------ */

console.log("\n[2] error handling");
{
  const notWav = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  let threw = false;
  try {
    await readWavHeader(new Blob([notWav]));
  } catch {
    threw = true;
  }
  ok(threw, "rejects non-RIFF data");

  // RIFF/WAVE with no data chunk
  const buf = new ArrayBuffer(40);
  const v = new DataView(buf);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 24, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  let threw2 = false;
  try {
    await readWavHeader(new Blob([buf]));
  } catch {
    threw2 = true;
  }
  ok(threw2, "rejects WAV without data chunk");
}

/* ------------------------------------------------------------------ */
/* 3. Streaming proof + memory on a large WAV                         */
/* ------------------------------------------------------------------ */

console.log("\n[3] large-file streaming (400 MB WAV)");
{
  const sampleRate = 48000;
  const channels = 2;
  const frames = 50_000_000; // 1000 s → 400 MB raw 16-bit stereo
  const rawBytes = frames * 2 * 2;
  const pcmBytes = frames * 2 * 4;

  console.log(`  generating ${(rawBytes / 1048576).toFixed(0)} MB raw / ${(pcmBytes / 1048576).toFixed(0)} MB PCM…`);
  const raw = makeWav({ channels, sampleRate, bits: 16, format: 1, frames });
  const blob = new Blob([raw]);

  // Track every slice requested from the blob.
  let maxSlice = 0;
  let fullFileRead = false;
  const origSlice = Blob.prototype.slice;
  Blob.prototype.slice = function (start?: number, end?: number) {
    const a = start ?? 0;
    const b = end ?? this.size;
    const len = b - a;
    if (len > maxSlice) maxSlice = len;
    if (len >= this.size * 0.9) fullFileRead = true; // a whole-file read
    return origSlice.call(this, a, b);
  };

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const baseRss = process.memoryUsage().rss;
  let peakRss = baseRss;

  const { pcm } = await parseWavStreaming(blob, {
    chunkBytes: 32 * 1024 * 1024,
    onProgress: () => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) peakRss = rss;
    },
  });

  Blob.prototype.slice = origSlice;
  gc?.();

  ok(!fullFileRead, "no full-file arrayBuffer/slice was ever requested", `(max slice ${(maxSlice / 1048576).toFixed(1)} MB)`);
  ok(maxSlice <= 512 * 1024 + 32 * 1024 * 1024, "max slice bounded by header prefix + 32 MiB chunk", `${(maxSlice / 1048576).toFixed(1)} MB`);

  const growth = peakRss - baseRss;
  const oldApproach = rawBytes + pcmBytes; // raw arrayBuffer + decoded PCM
  console.log(`  RSS growth: ${(growth / 1048576).toFixed(0)} MB (new approach budget ≈ ${(pcmBytes / 1048576).toFixed(0)} MB; legacy approach needed ≈ ${(oldApproach / 1048576).toFixed(0)} MB extra)`);
  ok(growth < pcmBytes * 1.35 + 128 * 1024 * 1024, "RSS growth ≈ decoded PCM only", `+${(growth / 1048576).toFixed(0)} MB`);
  ok(pcm.channels[0].length === frames, "all frames decoded");
}

/* ------------------------------------------------------------------ */
/* 4. Pre-computed peaks                                              */
/* ------------------------------------------------------------------ */

console.log("\n[4] computePeaks (≤ 2000, no decode)");
{
  const frames = 44100 * 12; // 12 s
  const ch: number[] = [];
  for (let i = 0; i < frames; i++) ch.push(0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const pcm = {
    sampleRate: 44100,
    channels: [new Float32Array(ch), new Float32Array(ch.map((x) => x * 0.8))],
  };
  const [pl, pr] = await computePeaks(pcm);
  ok(pl.length <= MAX_WAVEFORM_PEAKS, `peaks capped at ${MAX_WAVEFORM_PEAKS}`, `${pl.length}`);
  ok(pr.length <= MAX_WAVEFORM_PEAKS, "right channel capped too");
  let maxL = 0;
  for (let i = 0; i < pl.length; i++) if (pl[i] > maxL) maxL = pl[i];
  ok(maxL > 0.45 && maxL <= 1, "peak value sane (≈0.5)", `${maxL.toFixed(3)}`);

  const big = await computePeaks({ sampleRate: 48000, channels: [new Float32Array(48000 * 60).fill(0.25)] }, MAX_WAVEFORM_PEAKS);
  ok(big[0].length === MAX_WAVEFORM_PEAKS, "max resolution = exactly 2000 for long audio", `${big[0].length}`);
  ok(big[0][10] === 0.25, "peak values correct", `${big[0][10]}`);
}

/* ------------------------------------------------------------------ */
/* 5. Preview WAV builder                                             */
/* ------------------------------------------------------------------ */

console.log("\n[5] buildPreviewWav (22.05 kHz / 16-bit stereo)");
{
  const frames = 48000 * 3;
  const pcm = {
    sampleRate: 48000,
    channels: [
      new Float32Array(frames).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000)),
      new Float32Array(frames).map((_, i) => -0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000)),
    ],
  };
  const blob = await buildPreviewWav(pcm);
  ok(blob.type === "audio/wav", "MIME audio/wav");
  const header = await readWavHeader(blob);
  ok(header.sampleRate === 22050, "preview sample rate 22050", `${header.sampleRate}`);
  ok(header.numChannels === 2, "preview is stereo", `${header.numChannels}`);
  ok(header.bitsPerSample === 16, "preview is 16-bit", `${header.bitsPerSample}`);
  ok(approx(header.durationSec, 3, 0.02), "preview duration ≈ source", `${header.durationSec.toFixed(3)}s`);
  ok(blob.size < 300 * 1024, "preview is compact", `${(blob.size / 1024).toFixed(0)} KB`);

  // A 48 kHz source is downsampled; a 22.05 kHz source passes through.
  const pcm44 = { sampleRate: 22050, channels: [new Float32Array(22050 * 2), new Float32Array(22050 * 2)] };
  const b2 = await buildPreviewWav(pcm44);
  const h2 = await readWavHeader(b2);
  ok(h2.sampleRate === 22050 && h2.durationSec > 1.9 && h2.durationSec < 2.1, "native-rate passthrough", `${h2.durationSec.toFixed(2)}s`);
}

/* ------------------------------------------------------------------ */
/* 6. Memory verdicts                                                 */
/* ------------------------------------------------------------------ */

console.log("\n[6] memory verdicts & estimates");
{
  const GB = 1024 ** 3;
  ok(memoryVerdict(1 * GB, 2 * GB).level === "ok", "small project → ok");
  ok(memoryVerdict(2.2 * GB, 2 * GB).level === "warn", "slightly over budget → warn");
  ok(memoryVerdict(4 * GB, 2 * GB).level === "reject", "far over budget → reject");
  ok(memoryVerdict(0, 0).level === "ok", "zero project → ok");

  // estimateProjectPeakBytes only reads channel lengths — fake them to avoid
  // allocating the (gigabyte-sized) arrays in the test itself.
  const fake = (frames: number, ch = 2) =>
    ({ sampleRate: 48000, channels: Array.from({ length: ch }, () => ({ length: frames }) as unknown as Float32Array) }) as {
      sampleRate: number;
      channels: Float32Array[];
    };

  // 500 MB 16-bit stereo 48 kHz WAV ≈ 1.07 GB PCM; single track shares the
  // bus (zero-copy sum) → peak ≈ 2× PCM + headroom.
  const frames500 = (500 * 1024 * 1024) / 4;
  const est500 = estimateProjectPeakBytes([fake(frames500)]);
  ok(Math.abs(est500 - (frames500 * 2 * 4 * 2 + 64 * 1024 * 1024)) < 1, "single-track estimate = 2× PCM + 64 MB", `${(est500 / GB).toFixed(2)} GB`);

  // 32 × 50 MB stems → 3.2 GB PCM, small bus.
  const est32 = estimateProjectPeakBytes(Array.from({ length: 32 }, () => fake(12_500_000)));
  const approx32 = 32 * 12_500_000 * 2 * 4 + 2 * 12_500_000 * 2 * 4 + 64 * 1024 * 1024;
  ok(Math.abs(est32 - approx32) < 1, "multi-track estimate = tracks + 2× bus + 64 MB", `${(est32 / GB).toFixed(2)} GB`);

  // 4 GB phone (budget 1.6 GiB): 500 MB WAV warns, 1 GB WAV rejects.
  const budget4 = 4 * GB * 0.4;
  const peak500 = est500;
  const frames1000 = (1024 * 1024 * 1024) / 4;
  const peak1000 = estimateProjectPeakBytes([fake(frames1000)]);
  console.log(`  500 MB WAV peak ≈ ${(peak500 / GB).toFixed(2)} GB, 1 GB WAV peak ≈ ${(peak1000 / GB).toFixed(2)} GB, 4 GB phone budget ≈ ${(budget4 / GB).toFixed(2)} GB`);
  ok(memoryVerdict(peak1000, budget4).level === "reject", "1 GB WAV on 4 GB phone → reject (no crash, clear error)");
  ok(memoryVerdict(peak500, budget4).level === "warn" || memoryVerdict(peak500, budget4).level === "ok", "500 MB WAV on 4 GB phone → at most a warning");
  const budget8 = 8 * GB * 0.4;
  ok(memoryVerdict(peak500, budget8).level === "ok", "500 MB WAV on 8 GB phone → ok");
}

/* ------------------------------------------------------------------ */

console.log(failures === 0 ? "\nFILE-LOADER TESTS OK" : `\n${failures} TEST(S) FAILED`);
if (failures > 0) process.exit(1);
