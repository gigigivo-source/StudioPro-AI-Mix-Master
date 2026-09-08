/**
 * Small "brain" helpers shared by the chains.
 */
import type { ChainContext } from "./_types";

export const noteDur = (bpm: number, division: number): number =>
  Math.max(0.05, (60 / Math.max(40, bpm)) * division);

const GENRE_KEY = (ctx: ChainContext): string =>
  (ctx.settings.genre || "").toUpperCase();

/** Genre-relative ambience preference (multiplies a base decay / wet). */
export const genreAmbience = (ctx: ChainContext): number => {
  const g = GENRE_KEY(ctx);
  if (g === "CLASSICAL" || g === "ACOUSTIC" || g === "JAZZ") return 1.4;
  if (g === "ROCK" || g === "METAL") return 0.8;
  if (g === "HIP_HOP" || g === "R_AND_B" || g === "POP") return 0.7;
  if (g === "EDM") return 1.1;
  if (g === "LO_FI") return 0.9;
  return 1;
};

/** How aggressive dynamics / effect amounts should be, scaled by intensity. */
export const intensityFactor = (ctx: ChainContext): number =>
  0.6 + (ctx.settings.intensity / 100) * 0.8;

export const satAmount = (ctx: ChainContext, cap: number): number =>
  Math.min(cap, cap * intensityFactor(ctx));

/** De-esser centre frequency: low for silky voices, higher for harsh ones. */
export const deEssFreq = (sibilanceLevelDb: number): number => {
  if (sibilanceLevelDb > -55) return 8000;
  if (sibilanceLevelDb > -70) return 7000;
  return 6000;
};

/** Presence boost (2–4 dB @ 4 kHz) scaled by intensity + vocal focus. */
export const presenceGain = (ctx: ChainContext): number => {
  const base = 2 + ((ctx.settings.intensity / 100) * 2);
  return ctx.settings.vocalFocus ? Math.min(4, base + 0.8) : base;
};

/** Air boost (1–3 dB @ 12 kHz). */
export const airGain = (ctx: ChainContext): number => {
  return 1 + (ctx.settings.intensity / 100) * 2;
};

/**
 * Rough BPM estimate from an onset envelope autocorrelation.
 * Downsampled so it stays cheap even on minutes of audio.
 */
export function estimateBpm(
  pcm: { channels: Float32Array[]; sampleRate: number },
  channel = 0
): number {
  const src = pcm.channels[channel] ?? pcm.channels[0];
  const sr = pcm.sampleRate;
  const n = src.length;
  if (n < sr) return 120;
  const step = Math.max(1, Math.floor(sr / 500));
  const m = Math.floor(n / step);
  const env = new Float32Array(m);
  let prev = 0;
  for (let i = 0; i < m; i++) {
    const v = Math.abs(src[i * step]);
    env[i] = Math.max(0, v - prev);
    prev = v * 0.95;
  }
  const minLag = Math.max(1, Math.floor(sr / 200 / step));
  const maxLag = Math.ceil(sr / 60 / step);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag && lag < m; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < m; i += 4) ac += env[i] * env[i + lag];
    if (ac > best) {
      best = ac;
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return 120;
  const bpm = 60 / ((bestLag * step) / sr);
  return Math.min(200, Math.max(60, Math.round(bpm)));
}

/** Compressor threshold a few dB below the program RMS, clamped to be usable. */
export function compThreshold(ctx: ChainContext, dbBelow = 6): number {
  const a = ctx.analysis;
  const dr = Math.max(1, a.dynamicRange);
  const headroom = dbBelow - Math.min(3, dr * 0.15);
  return Math.max(-60, a.rms - headroom);
}
