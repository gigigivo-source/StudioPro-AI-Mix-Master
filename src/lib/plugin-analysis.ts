/**
 * plugin-analysis.ts — analysis used to drive plugin parameter decisions.
 * Every measurement is computed from the real PCM of a stem / the mix.
 */

import {
  measureLufs,
  measureTruePeak,
  type PcmData,
} from "./client-audio-engine";
import { dbToGain, gainToDb } from "./plugins/_core";

export type StemCategory =
  | "vocal"
  | "drums"
  | "bass"
  | "synth"
  | "guitar"
  | "other";

/** 1/3-octave band centre frequencies (ISO-ish), 20 Hz … 20 kHz. */
export const OCTAVE_BAND_CENTERS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];

/** RMS of all samples, in dBFS. */
export function measureRMS(buffer: PcmData): number {
  let sum = 0;
  let count = 0;
  for (const ch of buffer.channels) {
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  if (count === 0) return -120;
  return gainToDb(Math.sqrt(sum / count));
}

/** Peak (sample, or true-peak) in dBFS. */
export function measurePeak(buffer: PcmData): number {
  return gainToDb(measureTruePeak(buffer));
}

/** Integrated loudness, LUFS (gated, ITU-R BS.1770-4 approximation). */
export function measureLUFS(buffer: PcmData): number {
  return measureLufs(buffer);
}

/** Crest factor (peak-to-RMS ratio) in dB. */
export function measureDynamicRange(buffer: PcmData): number {
  const rms = measureRMS(buffer);
  const peak = measureTruePeak(buffer);
  const peakDb = gainToDb(peak);
  if (rms <= -119 || peakDb <= -119) return 0;
  return Math.max(0, peakDb - rms);
}

/* ------------------------------------------------------------------ *
 * FFT (radix-2) for the spectrum measure.
 * ------------------------------------------------------------------ */

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n === 0) return;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = re[i + k];
        const uI = im[i + k];
        const vR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const vI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + len / 2] = uR - vR;
        im[i + k + len / 2] = uI - vI;
        const nr = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nr;
      }
    }
  }
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/**
 * 1/3-octave spectrum (20 Hz – 20 kHz) averaged over frames, in dB.
 * Index i corresponds to OCTAVE_BAND_CENTERS[i].
 */
export function measureSpectrum(buffer: PcmData): Float32Array {
  const sr = buffer.sampleRate;
  const mix = new Float32Array(buffer.channels[0].length);
  const nCh = buffer.channels.length;
  for (let i = 0; i < mix.length; i++) {
    let v = buffer.channels[0][i];
    for (let c = 1; c < nCh; c++) v += buffer.channels[c][i];
    mix[i] = v / nCh;
  }

  const fftSize = Math.min(nextPow2(Math.floor(sr)), nextPow2(mix.length));
  if (fftSize < 64) return new Float32Array(OCTAVE_BAND_CENTERS.length);
  // Analysing minutes of audio isn't needed for decisions — a representative
  // window keeps per-stem cost low so long projects stay well under 30s.
  const analyseEnd = Math.min(mix.length, Math.floor(sr * 20));
  const hop = Math.max(fftSize / 2, 1);
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  const binHz = sr / fftSize;
  const bandEnergy = new Float64Array(OCTAVE_BAND_CENTERS.length);
  let frames = 0;
  const windowNorm = fftSize / 4; // sum of squares of hann approx

  for (let start = 0; start + fftSize <= analyseEnd; start += hop) {
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) re[i] = mix[start + i] * win[i];
    fft(re, im);

    // Bin band -> centre (edge via geometric midpoints of centres).
    const edges = [1.5 * OCTAVE_BAND_CENTERS[0]];
    for (let b = 1; b < OCTAVE_BAND_CENTERS.length; b++) {
      edges.push(Math.sqrt(OCTAVE_BAND_CENTERS[b - 1] * OCTAVE_BAND_CENTERS[b]));
    }
    edges.push(OCTAVE_BAND_CENTERS[OCTAVE_BAND_CENTERS.length - 1] * 1.5);

    for (let b = 0; b < edges.length - 1; b++) {
      const f0 = Math.max(binHz, edges[b]);
      const f1 = Math.min(sr / 2, edges[b + 1]);
      const k0 = Math.floor(f0 / binHz);
      const k1 = Math.min(fftSize / 2 - 1, Math.ceil(f1 / binHz) - 1);
      let e = 0;
      for (let k = Math.max(1, k0); k <= k1; k++) {
        e += re[k] * re[k] + im[k] * im[k];
      }
      bandEnergy[b] += e;
    }
    frames++;
  }

  const out = new Float32Array(OCTAVE_BAND_CENTERS.length);
  for (let b = 0; b < out.length; b++) {
    const avg = frames > 0 ? bandEnergy[b] / frames / windowNorm : 0;
    out[b] = avg > 1e-15 ? gainToDb(Math.sqrt(avg)) : -120;
  }
  return out;
}

/** Stereo correlation: mean normalised L·R, in [-1, 1]. */
export function measureCorrelation(buffer: PcmData): number {
  if (buffer.channels.length < 2) return 1; // mono = fully correlated
  const l = buffer.channels[0];
  const r = buffer.channels[1];
  const n = l.length;
  let dot = 0;
  let dl = 0;
  let dr = 0;
  const stride = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += stride) {
    dot += l[i] * r[i];
    dl += l[i] * l[i];
    dr += r[i] * r[i];
  }
  const denom = Math.sqrt(dl * dr);
  if (denom < 1e-12) return 1;
  return Math.min(1, Math.max(-1, dot / denom));
}

/** Percentage of samples (any channel) exceeding RMS + 12 dB (transients). */
export function measureTransientDensity(buffer: PcmData): number {
  const rms = measureRMS(buffer);
  const gate = dbToGain(rms) * dbToGain(12);
  let over = 0;
  let total = 0;
  for (const ch of buffer.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) > gate) over++;
      total++;
    }
  }
  return total > 0 ? (over / total) * 100 : 0;
}

/* ------------------------------------------------------------------ *
 * Category detection
 * ------------------------------------------------------------------ */

const CATEGORY_KEYWORDS: Array<[StemCategory, string[]]> = [
  ["vocal", ["vocal", "voice", "vox", "chorus", "harmony", "verse", "lyric", "acappella"]],
  ["drums", ["drum", "drumkit", "kick", "snare", "hat", "hihat", "cymbal", "cymb", "percussion", "perc", "kit", "clap", "toms", "rim", "crash", "ride"]],
  ["bass", ["bass", "sub", "808"]],
  ["synth", ["synth", "keys", "keyboard", "pad", "arp", "organ", "pluck"]],
  ["guitar", ["guitar", "acousticguitar", "elecguitar", "strum", "riff", "electric"]],
];

/**
 * Detect a stem's category from its filename; if the name is not telling,
 * fall back to a spectrum-based heuristic (energy where the fundamentals live).
 */
export function detectCategory(
  filename: string,
  spectrum?: Float32Array
): StemCategory {
  const base = filename.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const parts = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return classifyBySpectrum(spectrum);

  // Score each category: exact tokens are strongest, prefixes weaker.
  let hasAudioFamilyToken = false;
  for (const part of parts) {
    if (/synth|keys|pad|pluck|guitar|guit|electric|piano/.test(part)) {
      hasAudioFamilyToken = true;
    }
  }

  const scores: Partial<Record<StemCategory, number>> = {};
  const bump = (cat: StemCategory, w: number) => {
    scores[cat] = (scores[cat] ?? 0) + w;
  };

  for (const part of parts) {
    for (const [cat, kws] of CATEGORY_KEYWORDS) {
      for (const kw of kws) {
        if (part === kw) bump(cat, 5);
        else if (
          part.length >= 3 &&
          kw.length >= 3 &&
          (part.startsWith(kw) || kw.startsWith(part))
        ) {
          bump(cat, 1);
        }
      }
    }
    // "lead" is a voice role unless an instrument family is already indicated.
    if (part === "lead") bump(hasAudioFamilyToken ? "synth" : "vocal", 3);
    if (part === "guitar_vox" || part === "guitvox") bump("vocal", 5);
    if (/^(kick|snare|hat|clap|tom|cym|crash|ride|hihat)/.test(part)) bump("drums", 3);
    if (/^vox|^voc|^voice/.test(part)) bump("vocal", 5);
  }

  let best: StemCategory | null = null;
  let bestScore = 0;
  for (const [cat, s] of Object.entries(scores) as Array<[StemCategory, number]>) {
    if (s > bestScore) {
      bestScore = s;
      best = cat;
    }
  }
  if (best && bestScore >= 3) return best;

  // Frequency heuristic fallback.
  return classifyBySpectrum(spectrum);
}

function classifyBySpectrum(spectrum?: Float32Array): StemCategory {
  if (!spectrum || spectrum.length !== OCTAVE_BAND_CENTERS.length) return "other";
  if (spectrum && spectrum.length === OCTAVE_BAND_CENTERS.length) {
    const idx = (f: number) => OCTAVE_BAND_CENTERS.indexOf(f);
    const at = (f: number) => {
      const i = idx(f);
      return i >= 0 ? spectrum[i] : -120;
    };
    const sub = Math.max(at(40), at(50), at(63), at(80));
    const mid = Math.max(at(315), at(400), at(500), at(630), at(800), at(1000), at(1250), at(1600));
    const high = Math.max(at(4000), at(5000), at(6300), at(8000), at(10000));
    const sibilance = Math.max(at(6300), at(8000));

    if (sub > -80 && sub > mid + 6 && sub > high + 8) return "bass";
    if (high > -80 && sibilance > mid && sibilance > sub) return "vocal";
    if (high > -80 && high > sub + 4 && sibilance > sub) return "drums";
    if (mid > -80 && mid > sub + 4 && mid > high + 2) return "guitar";
    if (sub > -80 || mid > -80) return "synth";
  }
  return "other";
}
