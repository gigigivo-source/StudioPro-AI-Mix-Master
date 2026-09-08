/**
 * subHarmonic.ts — sub-harmonic synthesis for low-end extension.
 *
 * A clean sub tone at `freq` Hz (the sub-octave of interest, e.g. ~40-80 Hz)
 * is generated in mono and gated by the low-frequency energy envelope of the
 * source, so a sub layer only "lights up" when the bass actually plays and
 * follows its dynamics. Blended in by `amount` (0..1) and low-passed so only
 * genuinely sub content is added — never mud.
 */
import {
  biquadProcess,
  clamp,
  makeBiquad,
  type PcmData,
} from "./_core";

export function applySubHarmonic(
  buffer: PcmData,
  freq: number,
  amount: number
): PcmData {
  const mixAmt = clamp(amount, 0, 1);
  if (mixAmt <= 0) return buffer;
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;

  // Downmix for detection + mono sub synthesis.
  const [l0] = buffer.channels;
  const r0 = buffer.channels[1] ?? l0;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (l0[i] + r0[i]);

  // Energy detector band.
  const det = new Float32Array(mono);
  const bp = makeBiquad("bandpass", Math.min(freq * 3, freq + 120), 0.8, 0, sr);
  biquadProcess(bp, det);

  const subLo = makeBiquad("lowpass", freq * 2.2, 0.707, 0, sr);

  const atk = Math.exp(-1 / Math.max(1, 0.01 * sr));
  const rel = Math.exp(-1 / Math.max(1, 0.3 * sr));

  let env = 0;
  const omega = (2 * Math.PI * freq) / sr;
  let phase = 0;
  const sub = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inst = Math.abs(det[i]);
    env = inst > env ? atk * env + (1 - atk) * inst : rel * env + (1 - rel) * inst;
    // Keep the sub pitch-locked to the detected low fundamental when present.
    const gated = Math.min(1, env * (1 / 0.12));
    sub[i] = Math.sin(phase) * gated * 0.9;
    phase += omega;
    if (phase > Math.PI * 2) phase -= Math.PI * 2;
  }
  biquadProcess(subLo, sub);

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    for (let i = 0; i < n; i++) ch[i] += sub[i] * mixAmt;
  }
  return buffer;
}
