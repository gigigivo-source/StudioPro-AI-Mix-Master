/**
 * gain.ts — apply a constant gain (dB).
 * Used for gain staging, headroom trimming and trimming to a target RMS/LUFS.
 */
import { clonePcm, dbToGain, type PcmData } from "./_core";

/**
 * Multiply every sample by `gainDb` decibels.
 * @returns a new processed buffer.
 */
export function applyGain(buffer: PcmData, gainDb: number): PcmData {
  const g = dbToGain(gainDb);
  const out = clonePcm(buffer);
  for (const ch of out.channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
  return out;
}
