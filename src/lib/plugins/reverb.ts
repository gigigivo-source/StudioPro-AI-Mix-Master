/**
 * reverb.ts — algorithmic room reverb (Schroeder/Moorer network).
 * `decay` seconds sets the T60, `wet` 0..1 the mix. L/R combs use slightly
 * different lengths so the tail feels wide and natural.
 */
import { clamp, type PcmData } from "./_core";

function combDelay(buffer: Float32Array, input: Float32Array, ms: number, decay: number, sr: number): void {
  const len = Math.max(1, Math.floor((ms / 1000) * sr));
  const g = Math.pow(10, (-3 * ms) / 1000 / Math.max(decay, 0.1)); // T60 relation
  const dl = new Float32Array(len);
  let pos = 0;
  for (let i = 0; i < input.length; i++) {
    const out = dl[pos];
    dl[pos] = input[i] + out * g;
    pos++;
    if (pos >= len) pos = 0;
    buffer[i] = out;
  }
}

function allpass(buffer: Float32Array, ms: number, g: number, sr: number): void {
  const len = Math.max(1, Math.floor((ms / 1000) * sr));
  const dl = new Float32Array(len);
  let pos = 0;
  for (let i = 0; i < buffer.length; i++) {
    const delayed = dl[pos];
    const out = -g * buffer[i] + delayed;
    dl[pos] = buffer[i] + g * delayed;
    pos++;
    if (pos >= len) pos = 0;
    buffer[i] = out;
  }
}

export function applyReverb(
  buffer: PcmData,
  decay: number,
  wet: number
): PcmData {
  const w = clamp(wet, 0, 1);
  if (w <= 0 || buffer.channels.length === 0) return buffer;
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const [l0] = buffer.channels;
  const r0 = buffer.channels[1] ?? l0;

  // Mono downmix drives the reverb tail.
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (l0[i] + r0[i]);

  const reverb = new Float32Array(n);
  const combOut = new Float32Array(n);

  const combSpecs = [
    { ms: 29.7, l: 0.995, r: 0.997 },
    { ms: 37.1, l: 0.995, r: 0.998 },
    { ms: 41.1, l: 0.994, r: 0.996 },
    { ms: 43.7, l: 0.993, r: 0.997 },
  ];

  for (const spec of combSpecs) {
    combOut.fill(0);
    combDelay(combOut, mono, spec.ms, decay, sr);
    for (let i = 0; i < n; i++) reverb[i] += combOut[i];
  }
  // Scale so peak-ish level is sane regardless of comb count.
  const gain = 0.25;
  for (let i = 0; i < n; i++) reverb[i] *= gain;
  allpass(reverb, 5.0, 0.5, sr);
  allpass(reverb, 1.7, 0.5, sr);

  // Damp the high end for a smoother, less metallic tail.
  let lpf = 0;
  const damp = Math.exp(-1 / Math.max(1, (3000 / sr)));
  for (let i = 0; i < n; i++) {
    lpf += (reverb[i] - lpf) * damp;
    reverb[i] = lpf;
  }

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    const rScale = buffer.channels.length > 1 && c === 1 ? 1.0 : 1.0;
    for (let i = 0; i < n; i++) {
      ch[i] = ch[i] * (1 - w) + reverb[i] * w * rScale;
    }
  }
  return buffer;
}
