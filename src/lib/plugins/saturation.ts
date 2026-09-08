/**
 * saturation.ts — analog-style harmonic saturation.
 *  - 'tube': tanh soft-clip with a touch of even-harmonic asymmetry (warm).
 *  - 'tape': gentler saturation with slightly slower curve (smooth, tape-like).
 * `amount` is 0..1 (0 = bypass). Curves are small-signal-unity so perceived
 * gain stays near neutral — the added harmonics carry the effect.
 */
import { clamp, type PcmData } from "./_core";

export type SaturationType = "tube" | "tape";

export function applySaturation(
  buffer: PcmData,
  amount: number,
  type: SaturationType
): PcmData {
  const mix = clamp(amount, 0, 1);
  if (mix <= 0) return buffer;

  const n = buffer.channels[0].length;

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    const dry = new Float32Array(ch);

    if (type === "tube") {
      const drive = 1 + mix * 4;
      const norm = Math.tanh(drive);
      const asym = mix * 0.2;
      for (let i = 0; i < n; i++) {
        const x = dry[i];
        const shaped =
          Math.tanh(x * drive + asym * x * x * Math.sign(x)) / norm;
        ch[i] = dry[i] * (1 - mix) + shaped * mix;
      }
    } else {
      const drive = 1 + mix * 2.2;
      const norm = Math.tanh(drive);
      for (let i = 0; i < n; i++) {
        const x = dry[i];
        const shaped = Math.tanh(x * drive) / norm;
        ch[i] = dry[i] * (1 - mix) + shaped * mix;
      }
    }
  }
  return buffer;
}
