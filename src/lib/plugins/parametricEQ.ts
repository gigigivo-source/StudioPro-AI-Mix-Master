/**
 * parametricEQ.ts — bell / shelf EQ at a specific frequency.
 *  - 'bell' uses the RBJ peaking filter.
 *  - 'lowshelf' / 'highshelf' tilt the band up or down.
 */
import { clonePcm, filterPcm, type PcmData } from "./_core";

export type EqType = "bell" | "lowshelf" | "highshelf";

export function applyParametricEQ(
  buffer: PcmData,
  freq: number,
  gain: number,
  q: number,
  type: EqType
): PcmData {
  const filterType =
    type === "bell" ? "peaking" : type === "lowshelf" ? "lowshelf" : "highshelf";
  const out = clonePcm(buffer);
  filterPcm(filterType, freq, q, gain, out);
  return out;
}
