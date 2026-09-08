/**
 * audio-analysis.ts
 *
 * Real, sample-level measurement of PCM audio (no synthesis, no placeholders).
 * This is the audit layer: every value is computed from the user's own decoded
 * stems, then fed to the decision engine in audio-processors.ts.
 *
 *   - analyzeTrack(name, pcm)  -> per-stem audit (peak, RMS, LUFS, crest,
 *                                 dynamic range, correlation, transients,
 *                                 1/3-octave spectrum + resonances, category)
 *   - analyzeMix(pcm)          -> full-mix audit after summing
 *
 * Loudness + true-peak re-use the proven engine meters (ITU-R BS.1770-4
 * gated approximation + 4x oversampled peak) so the audit never disagrees with
 * the mastering core.
 */

import { measureLufs, type PcmData } from "./client-audio-engine";
import { guessCategory, type InstrumentCategory } from "./genre-presets";

export interface BandLevel {
  /** 1/3-octave centre frequency, Hz. */
  freq: number;
  /** Level in dB, relative to the spectrum mean (shape, ~±0 baseline). */
  db: number;
}

export interface TrackAudit {
  name: string;
  category: InstrumentCategory;
  sampleRate: number;
  durationSec: number;
  peakDb: number;
  rmsDb: number;
  lufs: number;
  /** Crest factor = peak - RMS (dB). */
  crestDb: number;
  /** p95-p5 spread of 400ms block RMS (dB). */
  dynamicRangeDb: number;
  /** Average L/R correlation, clamped 0..1 (mono/mid = 1). */
  correlation: number;
  /** Correlation mapped to width % (mono = 0, fully decorrelated = 100). */
  widthPct: number;
  /** Fraction of sampled inter-sample jumps above a transient threshold (0..1). */
  transientDensity: number;
  /** 1/3-octave band levels. */
  spectrum: BandLevel[];
  /** Bands that stand > ~6 dB above their neighbours (notch candidates). */
  resonances: BandLevel[];
}

/** Standard 1/3-octave centre frequencies, 20 Hz - 20 kHz. */
const OCTAVE_CENTERS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/* ------------------------------------------------------------------ *
 * FFT (radix-2, in-place) + spectrum estimation
 * ------------------------------------------------------------------ */

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Iterative radix-2 FFT. `re`/`im` length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation
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
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const aRe = re[i + j];
        const aIm = im[i + j];
        const bRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const bIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + len / 2] = aRe - bRe;
        im[i + j + len / 2] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** Log-magnitude 1/3-octave spectrum (levels relative to the mean = ~0 dB). */
function spectrumLevels(pcm: PcmData): BandLevel[] {
  const mono = pcm.channels[0];
  const sr = pcm.sampleRate;
  const n = mono.length;
  if (n < 64) return [];

  const nfft = nextPow2(Math.min(n, Math.floor(sr * 0.5))); // up to ~0.5s windows
  const win = Math.min(nfft, n);
  const bands = OCTAVE_CENTERS.map((f) => ({
    freq: f,
    lo: f / Math.pow(2, 1 / 6),
    hi: f * Math.pow(2, 1 / 6),
    power: 0,
    count: 0,
  }));

  const numWindows = Math.min(16, Math.max(1, Math.floor(n / win)));
  const step = Math.max(1, Math.floor((n - win) / numWindows));

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  // Hann window, precomputed
  const han = new Float64Array(win);
  for (let i = 0; i < win; i++) han[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (win - 1)));

  let windowed = 0;
  for (let w = 0; w < numWindows; w++) {
    const start = w * step;
    re.fill(0);
    im.fill(0);
    let energy = 0;
    for (let i = 0; i < win; i++) {
      const v = mono[start + i] * han[i];
      re[i] = v;
      energy += v * v;
    }
    if (energy < 1e-14) continue;
    windowed++;
    fft(re, im);
    for (let k = 1; k < win / 2; k++) {
      const fk = (k * sr) / nfft;
      const mag2 = re[k] * re[k] + im[k] * im[k];
      for (const b of bands) {
        if (fk >= b.lo && fk < b.hi) {
          b.power += mag2;
          b.count++;
        }
      }
    }
  }

  if (windowed === 0) return [];

  const active = bands.map((b) => (b.count > 0 ? b.power / b.count : NaN));
  const finite = active.filter((v) => Number.isFinite(v) && v > 1e-16);
  if (finite.length === 0) return [];
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const ref = Math.max(mean, 1e-16);

  return bands
    .map((b) => ({
      freq: b.freq,
      db: b.count > 0 ? 10 * Math.log10(Math.max(b.power / b.count, 1e-16) / ref) : -120,
    }))
    .filter((l) => l.db > -120);
}

/** Bands that are clear local maxima (> `excessDb` above both neighbours). */
function findResonances(bands: BandLevel[], excessDb = 6): BandLevel[] {
  const out: BandLevel[] = [];
  for (let i = 1; i < bands.length - 1; i++) {
    const cur = bands[i];
    const a = bands[i - 1].db;
    const b = bands[i + 1].db;
    const nbr = Math.max(a, b);
    // Only hunt in the regions that actually cause boxiness/mud/harshness.
    const audible = cur.freq >= 120 && cur.freq <= 10000;
    if (audible && cur.db - nbr >= excessDb && Number.isFinite(cur.db)) {
      out.push({ freq: cur.freq, db: cur.db });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Core single-signal measurements
 * ------------------------------------------------------------------ */

function peakDbOf(pcm: PcmData): number {
  let peak = 0;
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  return peak > 1e-9 ? 20 * Math.log10(peak) : -120;
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

/** p95-p5 of 400ms block RMS — a practical dynamic-range proxy. */
function dynamicRangeDbOf(pcm: PcmData): number {
  const mono = pcm.channels[0];
  const n = mono.length;
  const block = Math.max(1024, Math.floor(pcm.sampleRate * 0.4));
  if (n < block) return 0;
  const rms: number[] = [];
  for (let b = 0; b + block <= n; b += block) {
    let s = 0;
    for (let i = b; i < b + block; i++) s += mono[i] * mono[i];
    const r = s / block;
    if (r > 1e-12) rms.push(10 * Math.log10(r));
  }
  if (rms.length < 4) return 0;
  rms.sort((a, b) => a - b);
  const p = (q: number) => rms[Math.min(rms.length - 1, Math.floor(q * (rms.length - 1)))];
  return Math.max(0, p(0.95) - p(0.05));
}

function stereoCorrelation(pcm: PcmData): { corr: number; widthPct: number } {
  if (pcm.channels.length < 2) return { corr: 1, widthPct: 0 };
  const l = pcm.channels[0];
  const r = pcm.channels[1];
  const n = l.length;
  // Sample every 8th sample to keep this cheap on long files.
  let dot = 0;
  let dotL = 0;
  let dotR = 0;
  let cnt = 0;
  for (let i = 0; i < n; i += 8) {
    dot += l[i] * r[i];
    dotL += l[i] * l[i];
    dotR += r[i] * r[i];
    cnt++;
  }
  if (cnt === 0) return { corr: 1, widthPct: 0 };
  const denom = Math.sqrt(Math.max(dotL, 0) * Math.max(dotR, 0));
  const corr = denom > 1e-12 ? dot / denom : 1;
  const c = Math.min(1, Math.max(0, corr));
  return { corr: c, widthPct: Math.round(Math.min(1, Math.max(0, (1 - c) / 2)) * 100) };
}

function transientDensityOf(pcm: PcmData): number {
  const ch = pcm.channels[0];
  const n = ch.length;
  const targetSamples = 300_000;
  const stride = Math.max(1, Math.floor(n / targetSamples));
  let peak = 0;
  for (let i = 0; i < n; i += stride) {
    const a = Math.abs(ch[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return 0;
  const threshold = Math.max(0.01, peak * 0.3);
  let hits = 0;
  let count = 0;
  for (let i = stride; i < n; i += stride) {
    if (Math.abs(ch[i] - ch[i - 1]) > threshold) hits++;
    count++;
  }
  return count > 0 ? Math.min(1, hits / count) : 0;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function analyzeMix(pcm: PcmData): Omit<TrackAudit, "name" | "category"> {
  const peakDb = peakDbOf(pcm);
  const rmsDb = rmsDbOf(pcm);
  const spectrum = spectrumLevels(pcm);
  const corr = stereoCorrelation(pcm);
  return {
    sampleRate: pcm.sampleRate,
    durationSec: pcm.channels[0].length / pcm.sampleRate,
    peakDb,
    rmsDb,
    lufs: measureLufs(pcm),
    crestDb: peakDb - rmsDb,
    dynamicRangeDb: dynamicRangeDbOf(pcm),
    correlation: corr.corr,
    widthPct: corr.widthPct,
    transientDensity: transientDensityOf(pcm),
    spectrum,
    resonances: findResonances(spectrum),
  };
}

/** Per-stem audit + automatic instrument classification. */
export function analyzeTrack(name: string, pcm: PcmData): TrackAudit {
  const category = guessCategory(name);
  const base = analyzeMix(pcm);
  return { name, category, ...base };
}

export function analyzeTracks(tracks: { name: string; pcm: PcmData }[]): TrackAudit[] {
  return tracks.map((t) => analyzeTrack(t.name, t.pcm));
}

export function formatAudit(a: Pick<TrackAudit, "peakDb" | "rmsDb" | "lufs" | "crestDb" | "correlation">): string {
  return (
    `${a.rmsDb.toFixed(1)} dBFS avg, ${a.peakDb.toFixed(1)} dBFS peak, ` +
    `${a.lufs.toFixed(1)} LUFS, ${a.crestDb.toFixed(1)} dB crest, ` +
    `corr ${a.correlation.toFixed(2)}`
  );
}
