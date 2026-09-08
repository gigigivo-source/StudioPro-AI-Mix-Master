/**
 * _core.ts — Shared DSP primitives for the plugin engine.
 *
 * The whole app (and every plugin below) processes PCM as `PcmData`
 * ({ sampleRate, channels: Float32Array[] }), the exact live channel data that
 * an `AudioBuffer` exposes through `getChannelData()`. Plugin functions follow
 * the AudioBuffer convention — *process a buffer, return a (new) buffer* — but
 * operate on this equivalent representation so they run identically in the
 * browser and under Node (the smoke tests). Buffers are never mutated in a way
 * that would surprise the caller: each top-level plugin clones its input first.
 */

import type { PcmData } from "../client-audio-engine";

/** Re-export the canonical PCM shape used across the DSP engine. */
export type { PcmData } from "../client-audio-engine";

/* ------------------------------------------------------------------ *
 * Basic math
 * ------------------------------------------------------------------ */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

export const gainToDb = (g: number): number =>
  g > 1e-9 ? 20 * Math.log10(g) : -120;

/** Mix `a` and `b` linearly by `w` (0..1). */
export const mix = (a: number, b: number, w: number): number => a + (b - a) * w;

/* ------------------------------------------------------------------ *
 * Buffer helpers
 * ------------------------------------------------------------------ */

export function emptyPcm(
  sampleRate: number,
  length: number,
  channels = 2
): PcmData {
  return {
    sampleRate,
    channels: Array.from({ length: channels }, () => new Float32Array(length)),
  };
}

export function clonePcm(pcm: PcmData): PcmData {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => new Float32Array(c)),
  };
}

export function pcmFromAudioBuffer(buffer: AudioBuffer): PcmData {
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from(
      { length: buffer.numberOfChannels },
      (_, c) => new Float32Array(buffer.getChannelData(c))
    ),
  };
}

/** Stereo PCM (duplicate a mono buffer's channel when needed). */
export function toStereo(pcm: PcmData): PcmData {
  if (pcm.channels.length >= 2) return pcm;
  const [m] = pcm.channels;
  return { sampleRate: pcm.sampleRate, channels: [m, new Float32Array(m)] };
}

/** Copy the active PCM data into a fresh browser AudioBuffer when one exists. */
export function audioBufferFromPcm(pcm: PcmData): AudioBuffer {
  const Ctor =
    (globalThis as { AudioBuffer?: typeof AudioBuffer }).AudioBuffer;
  if (typeof Ctor !== "function") {
    throw new Error(
      "AudioBuffer is not available in this environment — use the PcmData API."
    );
  }
  const out = new Ctor({
    length: pcm.channels[0].length,
    numberOfChannels: pcm.channels.length,
    sampleRate: pcm.sampleRate,
  });
  for (let c = 0; c < pcm.channels.length; c++) {
    out.getChannelData(c).set(pcm.channels[c]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * RBJ biquad filters (Direct Form I, stateful) — the tonal workhorse.
 * ------------------------------------------------------------------ */

export type FilterType =
  | "lowpass"
  | "highpass"
  | "bandpass"
  | "notch"
  | "lowshelf"
  | "highshelf"
  | "peaking";

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export function makeBiquad(
  type: FilterType,
  freq: number,
  q: number,
  gainDb: number,
  sampleRate: number
): Biquad {
  const f = clamp(freq, 10, sampleRate * 0.49);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sin / (2 * Math.max(q, 1e-6));
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    a0 = 0,
    a1 = 0,
    a2 = 0;

  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "bandpass":
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "notch":
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case "lowshelf": {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - sq);
      a0 = A + 1 + (A - 1) * cos + sq;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - sq;
      break;
    }
    case "highshelf": {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - sq);
      a0 = A + 1 - (A - 1) * cos + sq;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - sq;
      break;
    }
    case "peaking":
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

export function biquadProcess(f: Biquad, data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1;
    f.x1 = x;
    f.y2 = f.y1;
    f.y1 = y;
    data[i] = y;
  }
}

/** Process every channel of a PCM buffer through a freshly-made filter. */
export function filterPcm(
  type: FilterType,
  freq: number,
  q: number,
  gainDb: number,
  pcm: PcmData
): void {
  const src = clonePcm(pcm);
  for (let c = 0; c < pcm.channels.length; c++) {
    const out = pcm.channels[c];
    const input = src.channels[c];
    const f = makeBiquad(type, freq, q, gainDb, pcm.sampleRate);
    for (let i = 0; i < out.length; i++) {
      const x = input[i];
      const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1;
      f.x1 = x;
      f.y2 = f.y1;
      f.y1 = y;
      out[i] = y;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Envelope followers (sample-accurate, in log-ish domain).
 * ------------------------------------------------------------------ */

export interface Envelope {
  env: number;
}

/** Process a detection signal into a smoothed envelope. */
export function smoothEnvelope(
  det: Float32Array,
  out: Float32Array,
  attack: number,
  release: number,
  sampleRate: number,
  logDomain = true
): number {
  const atk = Math.exp(-1 / Math.max(1, attack * sampleRate));
  const rel = Math.exp(-1 / Math.max(1, release * sampleRate));
  let env = 0;
  for (let i = 0; i < det.length; i++) {
    let target = det[i];
    if (logDomain) target = target <= 1e-12 ? -120 : 20 * Math.log10(target);
    const coef = target > env ? atk : rel;
    env = coef * env + (1 - coef) * target;
    out[i] = env;
  }
  return env;
}

/**
 * Compute a per-sample stereo level (dB) envelope from PCM channels.
 * Returns both the smoothed envelope (dB) and optionally stores RMS power.
 */
export function levelEnvelope(
  pcm: PcmData,
  attack: number,
  release: number,
  outDb: Float32Array,
  useRms = false
): void {
  const n = pcm.channels[0].length;
  const atk = Math.exp(-1 / Math.max(1, attack * pcm.sampleRate));
  const rel = Math.exp(-1 / Math.max(1, release * pcm.sampleRate));
  const [l] = pcm.channels;
  const r = pcm.channels[1] ?? l;
  let envDb = -120;
  for (let i = 0; i < n; i++) {
    const level = useRms
      ? Math.sqrt(0.5 * (l[i] * l[i] + r[i] * r[i]))
      : Math.max(Math.abs(l[i]), Math.abs(r[i]));
    let t = level <= 1e-12 ? -120 : 20 * Math.log10(level);
    const coef = t > envDb ? atk : rel;
    envDb = coef * envDb + (1 - coef) * t;
    outDb[i] = envDb;
  }
}

/* ------------------------------------------------------------------ *
 * Mid/Side
 * ------------------------------------------------------------------ */

/** Extract mid and side from stereo PCM into new arrays. */
export function midSide(l: Float32Array, r: Float32Array): {
  mid: Float32Array;
  side: Float32Array;
} {
  const n = l.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = 0.5 * (l[i] + r[i]);
    side[i] = 0.5 * (l[i] - r[i]);
  }
  return { mid, side };
}

/** Rebuild stereo L/R from mid/side arrays. */
export function fromMidSide(
  mid: Float32Array,
  side: Float32Array,
  l: Float32Array,
  r: Float32Array
): void {
  for (let i = 0; i < l.length; i++) {
    l[i] = mid[i] + side[i];
    r[i] = mid[i] - side[i];
  }
}

/* ------------------------------------------------------------------ *
 * Block helpers
 * ------------------------------------------------------------------ */

/** Mean power across all channels of a segment. */
export function blockPower(ch: Float32Array[], start: number, end: number): number {
  let sum = 0;
  for (const c of ch) {
    let s = 0;
    for (let i = start; i < end; i++) s += c[i] * c[i];
    sum += s / (end - start);
  }
  return sum / ch.length;
}

/** Peak absolute sample across channels within a segment. */
export function blockPeak(ch: Float32Array[], start: number, end: number): number {
  let p = 0;
  for (const c of ch) {
    for (let i = start; i < end; i++) {
      const a = Math.abs(c[i]);
      if (a > p) p = a;
    }
  }
  return p;
}
