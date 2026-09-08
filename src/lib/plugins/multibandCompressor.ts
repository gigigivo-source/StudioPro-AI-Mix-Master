/**
 * multibandCompressor.ts — split into 3 bands (low / mid / high) via
 * subtractive (Linkwitz-like) crossovers and compress each band separately,
 * then recombine. Lets you clamp the low end hard without dulling transients
 * up top (and vice-versa).
 */
import { dbToGain, makeBiquad, biquadProcess, type PcmData } from "./_core";

export interface BandParams {
  threshold: number;
  ratio: number;
}

export interface MultibandCompressorParams {
  low: BandParams;
  mid: BandParams;
  high: BandParams;
}

export interface MultibandOptions {
  lowHz?: number;
  highHz?: number;
  attack?: number;
  release?: number;
  knee?: number;
}

interface BandArray {
  l: Float32Array;
  r: Float32Array;
}

/** Split stereo into low / mid / high arrays that sum back to the input. */
function splitBands(
  pcm: PcmData,
  lowHz: number,
  highHz: number
): { low: BandArray; mid: BandArray; high: BandArray } {
  const sr = pcm.sampleRate;
  const n = pcm.channels[0].length;
  const lIn = pcm.channels[0];
  const rIn = pcm.channels[1] ?? lIn;

  const low = { l: new Float32Array(n), r: new Float32Array(n) };
  const mid = { l: new Float32Array(n), r: new Float32Array(n) };
  const high = { l: new Float32Array(n), r: new Float32Array(n) };

  const lpL = makeBiquad("lowpass", lowHz, 0.707, 0, sr);
  const lpR = makeBiquad("lowpass", lowHz, 0.707, 0, sr);
  const hpL = makeBiquad("highpass", highHz, 0.707, 0, sr);
  const hpR = makeBiquad("highpass", highHz, 0.707, 0, sr);

  low.l.set(lIn);
  low.r.set(rIn);
  biquadProcess(lpL, low.l);
  biquadProcess(lpR, low.r);

  high.l.set(lIn);
  high.r.set(rIn);
  biquadProcess(hpL, high.l);
  biquadProcess(hpR, high.r);

  // mid = input - low - high (complementary reconstruction).
  for (let i = 0; i < n; i++) {
    mid.l[i] = lIn[i] - low.l[i] - high.l[i];
    mid.r[i] = rIn[i] - low.r[i] - high.r[i];
  }

  return { low, mid, high };
}

/** Feed-forward compressor on a pair of channels; returns avg gain reduction dB. */
function compressBand(
  band: BandArray,
  params: BandParams,
  attack: number,
  release: number,
  knee: number,
  sr: number
): void {
  const n = band.l.length;
  const atk = Math.exp(-1 / Math.max(1, attack * sr));
  const rel = Math.exp(-1 / Math.max(1, release * sr));
  const invRatio = 1 / Math.max(1, params.ratio);
  const halfKnee = knee / 2;

  let envDb = -120;
  let smoothed = 1;
  const gAtk = Math.exp(-1 / Math.max(1, 0.005 * sr));
  const gRel = Math.exp(-1 / Math.max(1, 0.05 * sr));

  for (let i = 0; i < n; i++) {
    const level = Math.max(Math.abs(band.l[i]), Math.abs(band.r[i]));
    const instDb = level <= 1e-12 ? -120 : 20 * Math.log10(level);
    const coef = instDb > envDb ? atk : rel;
    envDb = coef * envDb + (1 - coef) * instDb;

    let gr = 0;
    if (envDb > params.threshold - halfKnee) {
      const over = envDb - params.threshold;
      if (over > halfKnee) {
        gr = -((over - halfKnee) * (1 - invRatio)) -
          halfKnee * (1 - invRatio) * 0.5;
      } else {
        const x = over + halfKnee;
        gr = -((1 - invRatio) * x * x) / (2 * knee);
      }
    }
    const target = dbToGain(gr);
    smoothed =
      smoothed + (target - smoothed) * (target < smoothed ? gAtk : gRel);
    band.l[i] *= smoothed;
    band.r[i] *= smoothed;
  }
}

export function applyMultibandCompressor(
  buffer: PcmData,
  bands: MultibandCompressorParams,
  opts: MultibandOptions = {}
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const lowHz = opts.lowHz ?? 200;
  const highHz = opts.highHz ?? 2000;
  const attack = opts.attack ?? 0.01;
  const release = opts.release ?? 0.15;
  const knee = opts.knee ?? 6;

  const { low, mid, high } = splitBands(buffer, lowHz, highHz);

  compressBand(low, bands.low, attack, release, knee, sr);
  compressBand(mid, bands.mid, attack, release, knee, sr);
  compressBand(high, bands.high, attack, release, knee, sr);

  const outL = buffer.channels[0];
  const outR = buffer.channels[1] ?? outL;
  for (let i = 0; i < n; i++) {
    outL[i] = low.l[i] + mid.l[i] + high.l[i];
    outR[i] = low.r[i] + mid.r[i] + high.r[i];
  }
  return buffer;
}
