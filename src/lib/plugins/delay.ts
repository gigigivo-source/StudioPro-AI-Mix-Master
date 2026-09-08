/**
 * delay.ts — simple feedback (echo) delay.
 * `time` seconds, `feedback` 0..1, `wet` 0..1 mix.
 */
import { clamp, type PcmData } from "./_core";

export function applyDelay(
  buffer: PcmData,
  time: number,
  feedback: number,
  wet: number
): PcmData {
  const sr = buffer.sampleRate;
  const delaySamples = Math.max(1, Math.floor(time * sr));
  const fb = clamp(feedback, 0, 0.95);
  const w = clamp(wet, 0, 1);
  if (w <= 0) return buffer;
  const n = buffer.channels[0].length;

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    const buf = new Float32Array(delaySamples);
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const d = buf[pos];
      buf[pos] = ch[i] + d * fb;
      pos++;
      if (pos >= delaySamples) pos = 0;
      ch[i] = ch[i] * (1 - w) + d * w;
    }
  }
  return buffer;
}
