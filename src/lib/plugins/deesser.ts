/**
 * deesser.ts — reduce sibilance around `freq` (typically 5-8 kHz).
 *
 * A band-limited side chain detects harsh sibilance above `threshold`; the
 * offending high-frequency component is attenuated (wideband-ish de-essing
 * of the top band only) so vowels and body stay untouched.
 */
import {
  biquadProcess,
  dbToGain,
  makeBiquad,
  type PcmData,
} from "./_core";

export function applyDeesser(
  buffer: PcmData,
  threshold: number,
  freq: number
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const atk = Math.exp(-1 / Math.max(1, 0.001 * sr)); // 1 ms
  const rel = Math.exp(-1 / Math.max(1, 0.06 * sr)); // 60 ms
  const ratio = 4; // downward: how much each dB above threshold is cut
  const invRatio = 1 / ratio;

  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];

    // Low band (below the sibilance region) is never touched.
    const low = new Float32Array(ch);
    const lp = makeBiquad("lowpass", freq * 0.6, 0.707, 0, sr);
    biquadProcess(lp, low);

    // Side-chain detector at the sibilance centre.
    const det = new Float32Array(ch);
    const bp = makeBiquad("bandpass", freq, 0.9, 0, sr);
    biquadProcess(bp, det);

    let envDb = -120;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(det[i]);
      const instDb = a <= 1e-9 ? -120 : 20 * Math.log10(a);
      const coef = instDb > envDb ? atk : rel;
      envDb = coef * envDb + (1 - coef) * instDb;

      let gDb = 0;
      if (envDb > threshold) {
        const over = envDb - threshold;
        // Curve: gentle up to 2 dB over, then increasingly firm.
        gDb = -(Math.min(over, 2) * 0.25 + Math.max(0, over - 2) * invRatio);
      }
      const g = dbToGain(gDb);
      // Output = untouched lows + attenuated highs (low already includes body).
      const hi = ch[i] - low[i];
      ch[i] = low[i] + hi * g;
    }
  }

  return buffer;
}
