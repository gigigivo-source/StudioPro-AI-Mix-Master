/**
 * chorus.ts — chorus / modulation for width & movement.
 * `rate` LFO Hz, `depth` 0..1 (modulation depth in milliseconds), `wet` 0..1.
 * Left/right LFO phases are offset so the widening feels natural.
 */
import { clamp, type PcmData } from "./_core";

export function applyChorus(
  buffer: PcmData,
  rate: number,
  depth: number,
  wet: number
): PcmData {
  const w = clamp(wet, 0, 1);
  if (w <= 0) return buffer;
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const depthMs = clamp(depth, 0, 1) * 7; // up to ~7 ms of delay sweep
  const baseMs = 8; // fixed pre-delay so the sweep has headroom
  const base = Math.floor((baseMs / 1000) * sr);
  const maxSweep = Math.max(1, Math.floor((depthMs / 1000) * sr));
  const bufLen = base + maxSweep + 4;

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    const delayBuf = new Float32Array(bufLen);
    let write = 0;
    const phaseOffset = buffer.channels.length > 1 && c === 1 ? Math.PI : 0;
    for (let i = 0; i < n; i++) {
      delayBuf[write] = ch[i];
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * rate * (i / sr) + phaseOffset);
      const offset = base + lfo * maxSweep;
      let read = write - offset;
      while (read < 0) read += bufLen;
      while (read >= bufLen) read -= bufLen;
      const r0 = Math.floor(read);
      const r1 = (r0 + 1) % bufLen;
      const frac = read - r0;
      const mod = delayBuf[r0] + (delayBuf[r1] - delayBuf[r0]) * frac;
      ch[i] = ch[i] * (1 - w) + mod * w;
      write++;
      if (write >= bufLen) write = 0;
    }
  }
  return buffer;
}
