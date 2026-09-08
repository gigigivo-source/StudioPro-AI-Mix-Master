/**
 * stereoWidener.ts — mid/side width control.
 *
 * width 1 = original, >1 = wider, <1 = narrower (toward mono). Low-frequency
 * side content (<~160 Hz) is always kept near-mono so widening never makes the
 * low end collapse, lose punch, or cause mono-compatibility problems.
 */
import {
  biquadProcess,
  clonePcm,
  fromMidSide,
  makeBiquad,
  midSide,
  type PcmData,
} from "./_core";

const MONO_LP_HZ = 160;

export function applyStereoWidener(buffer: PcmData, width: number): PcmData {
  if (buffer.channels.length < 2) return buffer; // nothing to widen in mono
  const out = clonePcm(buffer);
  const n = buffer.channels[0].length;

  const { mid, side } = midSide(out.channels[0], out.channels[1]);
  const sr = out.sampleRate;

  // Low side component stays mono-ish regardless of requested width.
  const lowSide = new Float32Array(side);
  const lp = makeBiquad("lowpass", MONO_LP_HZ, 0.707, 0, sr);
  biquadProcess(lp, lowSide);

  const sideW = Math.max(0, Math.min(2.5, width));
  for (let i = 0; i < n; i++) {
    const hiSide = side[i] - lowSide[i];
    side[i] = lowSide[i] + hiSide * sideW;
  }

  fromMidSide(mid, side, out.channels[0], out.channels[1]);
  return out;
}
