/**
 * End-to-end smoke test of the results pipeline (runs in Node 22, which has
 * a global AudioBuffer). Mirrors exactly what page.tsx does:
 *   tracks -> toPcm -> sumTracks -> measureAll (before)
 *          -> clonePcm -> masterStereoPcm -> measureAll (after)
 *          -> wavBlob 16/24 -> encodeMp3(320) -> buildStemsZip
 */
import { masterStereoPcm, sumTracks, type PcmData } from "../src/lib/client-audio-engine.ts";
import { measureAll } from "../src/lib/analysis.ts";
import { wavBlob, encodeMp3, buildStemsZip, baseName } from "../src/lib/exports.ts";

/** Node has no AudioBuffer global — a duck-typed stand-in with the same interface. */
class FakeAudioBuffer {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  get numberOfChannels() {
    return this.channels.length;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number) {
    return this.channels[c];
  }
  constructor(sampleRate: number, length: number) {
    this.sampleRate = sampleRate;
    this.length = length;
    this.channels = [new Float32Array(length), new Float32Array(length)];
  }
}

function makeBuffer(freq: number, seconds: number, sampleRate = 44100): AudioBuffer {
  const length = Math.floor(seconds * sampleRate);
  const buffer = new FakeAudioBuffer(sampleRate, length) as unknown as AudioBuffer;
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 4, (seconds - t) * 4);
    // A "mix": fundamental + sub + slight stereo difference
    l[i] = 0.5 * env * (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * freq * 0.5 * t));
    r[i] = 0.5 * env * (Math.sin(2 * Math.PI * freq * t + 0.12) + 0.4 * Math.sin(2 * Math.PI * freq * 0.5 * t - 0.08));
  }
  return buffer;
}

const toPcm = (b: AudioBuffer): PcmData => ({
  sampleRate: b.sampleRate,
  channels: Array.from({ length: b.numberOfChannels }, (_, c) => new Float32Array(b.getChannelData(c))),
});

const clonePcm = (pcm: PcmData): PcmData => ({
  sampleRate: pcm.sampleRate,
  channels: pcm.channels.map((c) => new Float32Array(c)),
});

const t0 = Date.now();
const tracks = [makeBuffer(110, 2), makeBuffer(220, 2)];

// --- Stage 1: mixing ---
const originalPcm = sumTracks(tracks.map(toPcm));
console.log(`summed: ${originalPcm.channels[0].length} samples @ ${originalPcm.sampleRate}`);

const before = await measureAll(originalPcm);
console.log("BEFORE:", JSON.stringify(before, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));

// --- Stage 2: mastering ---
const work = clonePcm(originalPcm);
let lastF = 0;
const mastered = await masterStereoPcm(work, {
  genre: "POP",
  loudness: "SPOTIFY",
  intensity: 75,
  vocalFocus: true,
  onProgress: (f) => { lastF = f; },
});
console.log(`mastered (final progress ${lastF})`);

// --- Stage 3: QC ---
const after = await measureAll(mastered);
console.log("AFTER: ", JSON.stringify(after, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v)));

// The master must hit the target loudness and stay under the TP ceiling.
// (Whether it got louder or quieter depends on the source material.)
if (Math.abs(after.lufs - -14) > 0.5) throw new Error(`LUFS target missed: ${after.lufs}`);
if (after.truePeakDb > -0.9) throw new Error(`True peak above ceiling: ${after.truePeakDb}`);
if (before.lufs === after.lufs && before.truePeakDb === after.truePeakDb) {
  throw new Error("Mastering changed nothing");
}
if (work.channels[0].every((v, i) => v === originalPcm.channels[0][i])) throw new Error("original was mutated!");

// --- Exports ---
const w16 = wavBlob(mastered, 16);
const w24 = wavBlob(mastered, 24);
console.log(`WAV16: ${(w16.size / 1024).toFixed(1)} KB  WAV24: ${(w24.size / 1024).toFixed(1)} KB`);

let mp3Max = 0;
const mp3 = await encodeMp3(mastered, 320, (f) => { mp3Max = f; });
console.log(`MP3 320: ${(mp3.size / 1024).toFixed(1)} KB (progress reached ${mp3Max})`);
if (mp3.size < w16.size / 10) throw new Error("MP3 suspiciously small");
if (mp3Max < 1) throw new Error("MP3 progress never completed");

// In this Node ESM run the package resolves through the "import" condition
// (the real ESM dist) — the same path the browser bundle uses.
const lameNs = await import("@breezystack/lamejs");
if (typeof lameNs.Mp3Encoder !== "function") {
  throw new Error("Mp3Encoder not resolvable via the ESM import condition");
}
console.log("lamejs: Mp3Encoder resolved via ESM import condition ✓");

const zip = await buildStemsZip(tracks.map((b, i) => ({ name: `drum_${i}.wav`, buffer: b })));
console.log(`Stems ZIP: ${(zip.size / 1024).toFixed(1)} KB`);
if (zip.size < 100_000) throw new Error("ZIP suspiciously small");

console.log(`baseName("my song (final).zip") = ${baseName("my song (final).zip")}`);
console.log(`\nPIPELINE OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
