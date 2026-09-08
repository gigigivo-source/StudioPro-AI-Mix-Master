/**
 * gate.ts — noise gate / downward expander. Attenuates low-level signal below
 * `threshold` dB (with a ratio so it can behave like a gentle expander too).
 */
import { dbToGain, type PcmData } from "./_core";

export function applyGate(
  buffer: PcmData,
  threshold: number,
  attack: number,
  release: number
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const [l] = buffer.channels;
  const r = buffer.channels[1] ?? l;
  const ratio = 12; // strong downward expansion below threshold

  const atk = Math.exp(-1 / Math.max(1, attack * sr));
  const rel = Math.exp(-1 / Math.max(1, release * sr));
  const gAtk = Math.exp(-1 / Math.max(1, 0.001 * sr));
  const gRel = Math.exp(-1 / Math.max(1, 0.08 * sr));

  let envDb = -120;
  let smoothed = 1;
  for (let i = 0; i < n; i++) {
    const level = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    const instDb = level <= 1e-12 ? -120 : 20 * Math.log10(level);
    const coef = instDb > envDb ? atk : rel;
    envDb = coef * envDb + (1 - coef) * instDb;

    let g = 1;
    if (envDb < threshold) {
      const gDb = Math.max(-60, (envDb - threshold) * (1 - 1 / ratio));
      g = dbToGain(gDb);
    }
    smoothed = smoothed + (g - smoothed) * (g < smoothed ? gAtk : gRel);
    l[i] *= smoothed;
    if (buffer.channels[1]) r[i] *= smoothed;
  }
  return buffer;
}
