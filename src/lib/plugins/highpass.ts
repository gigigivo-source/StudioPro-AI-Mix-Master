/**
 * highpass.ts — high-pass filter (remove low frequencies below a cutoff).
 * Default Q 0.707 = 2nd order Butterworth (-12 dB/oct).
 */
import { clonePcm, filterPcm, type PcmData } from "./_core";

export function applyHighpass(
  buffer: PcmData,
  freq: number,
  q = 0.707
): PcmData {
  const out = clonePcm(buffer);
  filterPcm("highpass", freq, q, 0, out);
  return out;
}
