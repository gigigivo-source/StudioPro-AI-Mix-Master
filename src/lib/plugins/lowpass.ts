/**
 * lowpass.ts — low-pass filter (remove high frequencies above a cutoff).
 */
import { clonePcm, filterPcm, type PcmData } from "./_core";

export function applyLowpass(
  buffer: PcmData,
  freq: number,
  q = 0.707
): PcmData {
  const out = clonePcm(buffer);
  filterPcm("lowpass", freq, q, 0, out);
  return out;
}
