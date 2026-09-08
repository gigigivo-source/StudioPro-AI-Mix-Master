/**
 * transientShaper.ts — adjust attack / sustain character.
 *
 * `attack` and `sustain` are ratios around 1.0 (e.g. drums: attack 0.8-1.3,
 * sustain 0.5-1.2). The algorithm separates each sample into a transient
 * (fresh-onset) share and a sustained (body) share via two magnitude
 * envelopes with different time constants, then weights the waveform by the
 * two shaping amounts. Bounded and stable for any reasonable input.
 */
import { clamp, type PcmData } from "./_core";

export function applyTransientShaper(
  buffer: PcmData,
  attack: number,
  sustain: number
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;

  // Envelope constants (seconds).
  const att = Math.exp(-1 / Math.max(1, 0.0004 * sr)); // onset catch
  const relO = Math.exp(-1 / Math.max(1, 0.12 * sr)); // onset hold/release
  const aB = Math.exp(-1 / Math.max(1, 0.015 * sr)); // body attack
  const rB = Math.exp(-1 / Math.max(1, 0.25 * sr)); // body release

  const aEff = attack - 1;
  const sEff = sustain - 1;

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    let oe = 0; // onset envelope
    let be = 0; // body envelope
    for (let i = 0; i < n; i++) {
      const mag = Math.abs(ch[i]);
      const oC = mag > oe ? att : relO;
      oe = oC * oe + (1 - oC) * mag;
      const bC = mag > be ? aB : rB;
      be = bC * be + (1 - bC) * mag;

      const denom = oe + be + 1e-12;
      const trNorm = clamp((oe - be) / denom, 0, 1); // onset-heavy share
      const bodyNorm = 1 - trNorm;
      const gain = clamp(
        1 + aEff * trNorm + sEff * bodyNorm,
        0.02,
        4
      );
      ch[i] *= gain;
    }
  }
  return buffer;
}
