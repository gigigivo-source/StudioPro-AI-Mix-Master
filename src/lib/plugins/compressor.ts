/**
 * compressor.ts — standard dynamics compressor with a soft knee.
 *
 * Feed-forward topology on a shared (L/R-max) peak envelope. When the
 * envelope is inside the knee a quadratic curve is applied; above it the
 * classic `ratio` slope. An automatic make-up gain (average gain reduction)
 * keeps perceived level stable, which is what makes it sound "professional"
 * without any user tweaking.
 */
import { dbToGain, type PcmData } from "./_core";

export interface CompressorParams {
  threshold: number; // dB
  ratio: number;
  attack: number; // seconds
  release: number; // seconds
  knee: number; // dB
}

export function applyCompressor(
  buffer: PcmData,
  threshold: number,
  ratio: number,
  attack: number,
  release: number,
  knee: number
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const [l] = buffer.channels;
  const r = buffer.channels[1] ?? l;

  const atk = Math.exp(-1 / Math.max(1, attack * sr));
  const rel = Math.exp(-1 / Math.max(1, release * sr));
  const invRatio = 1 / Math.max(1, ratio);
  const halfKnee = knee / 2;

  // Gain envelope is shared across channels to keep the stereo image stable.
  const gains = new Float32Array(n);
  let envDb = -120;
  let makeupDb = 0;
  let activeSamples = 0;
  let grSum = 0;

  for (let i = 0; i < n; i++) {
    const level = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    const instDb = level <= 1e-12 ? -120 : 20 * Math.log10(level);
    const coef = instDb > envDb ? atk : rel;
    envDb = coef * envDb + (1 - coef) * instDb;

    let gr = 0;
    if (knee > 0 && envDb > threshold - halfKnee) {
      const over = envDb - threshold;
      if (over > halfKnee) {
        gr = -((over - halfKnee) * (1 - invRatio)) -
          halfKnee * (1 - invRatio) * 0.5;
      } else {
        // Soft knee quadratic.
        const x = over + halfKnee;
        gr = -((1 - invRatio) * x * x) / (2 * knee);
      }
    } else if (envDb > threshold) {
      gr = -(envDb - threshold) * (1 - invRatio);
    }

    gains[i] = dbToGain(gr);
    if (gr < -0.05) {
      grSum += gr;
      activeSamples++;
    }
  }

  if (activeSamples > 0) {
    makeupDb = -grSum / activeSamples;
  }
  const makeup = dbToGain(makeupDb);

  // Apply (post) envelope smoothing on the gains to avoid zipper noise.
  let smoothed = 1;
  const gAtk = Math.exp(-1 / Math.max(1, 0.005 * sr));
  const gRel = Math.exp(-1 / Math.max(1, 0.05 * sr));
  for (let i = 0; i < n; i++) {
    const target = gains[i];
    smoothed =
      smoothed + (target - smoothed) * (target < smoothed ? gAtk : gRel);
    const g = smoothed * makeup;
    l[i] *= g;
    if (buffer.channels[1]) r[i] *= g;
  }

  return buffer;
}
