/**
 * dynamicEQ.ts — dynamic EQ: only boosts a band when the program is *quiet*
 * at that frequency, so adding presence never makes loud material harsh.
 *
 * A copy is shaped with a fixed peaking boost, then the original and the
 * boosted copy are blended sample-by-sample by a smoothed side-chain
 * "quietness" envelope measured at the target band.
 */
import { biquadProcess, clonePcm, makeBiquad, type PcmData } from "./_core";

export function applyDynamicEQ(
  buffer: PcmData,
  freq: number,
  maxGain: number,
  threshold: number,
  q: number
): PcmData {
  const out = clonePcm(buffer);
  const boosted = clonePcm(buffer);
  const sr = buffer.sampleRate;

  for (let c = 0; c < boosted.channels.length; c++) {
    const f = makeBiquad("peaking", freq, q, maxGain, sr);
    biquadProcess(f, boosted.channels[c]);
  }

  const RANGE = 12; // dB over which quietness ramps in below threshold
  const atk = Math.exp(-1 / Math.max(1, 0.02 * sr)); // 20 ms
  const rel = Math.exp(-1 / Math.max(1, 0.15 * sr)); // 150 ms

  for (let c = 0; c < out.channels.length; c++) {
    const src = buffer.channels[c];
    const dst = out.channels[c];
    const bst = boosted.channels[c];

    // Band-limited side-chain detector at the EQ centre frequency.
    const det = new Float32Array(src);
    const bp = makeBiquad("bandpass", freq, q, 0, sr);
    biquadProcess(bp, det);

    let envDb = -120;
    let weight = 0;
    for (let i = 0; i < src.length; i++) {
      const a = Math.abs(det[i]);
      const instDb = a <= 1e-9 ? -120 : 20 * Math.log10(a);
      const coef = instDb > envDb ? atk : rel;
      envDb = coef * envDb + (1 - coef) * instDb;

      // Quiet material (below threshold) gets up to full boost.
      const target = Math.max(
        0,
        Math.min(1, (threshold - envDb) / RANGE)
      );
      weight = weight + (target - weight) * (target > weight ? atk : rel);
      dst[i] = src[i] + (bst[i] - src[i]) * weight;
    }
  }

  return out;
}
