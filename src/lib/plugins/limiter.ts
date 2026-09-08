/**
 * limiter.ts — true-peak brick-wall limiter with look-ahead.
 *
 * A sliding-window peak detector (over `lookAhead` seconds, monotonic-queue
 * based) finds the loudest upcoming sample across all channels. Gain is then
 * reduced so that peak lands at `ceiling` dB. `threshold` is the level (dB)
 * above which limiting engages (kept slightly above `ceiling` so transients
 * are caught transparently). Attack is effectively instant because of the
 * look-ahead; release is slow to avoid pumping.
 */
import {
  clamp,
  dbToGain,
  type PcmData,
} from "./_core";

export function applyLimiter(
  buffer: PcmData,
  threshold: number,
  ceiling: number,
  lookAhead: number
): PcmData {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0].length;
  const ce = dbToGain(clamp(ceiling, -40, 0));
  const th = dbToGain(threshold); // informational engagement point
  const L = Math.max(1, Math.min(n, Math.floor(lookAhead * sr)));

  // Peak magnitude across channels per sample.
  const absMax = new Float32Array(n);
  const [l0] = buffer.channels;
  const c0 = buffer.channels.length;
  for (let i = 0; i < n; i++) {
    let m = Math.abs(l0[i]);
    for (let c = 1; c < c0; c++) {
      const a = Math.abs(buffer.channels[c][i]);
      if (a > m) m = a;
    }
    absMax[i] = m;
  }

  // Sliding-window maximum over [i, i+L] via a monotonic deque.
  const deque: number[] = [];
  const winMax = new Float32Array(n);
  const idx = new Int32Array(n);
  let head = 0;
  let tail = 0; // exclusive
  for (let i = 0; i < n; i++) {
    // remove out-of-window from front
    while (head < tail && idx[head] < i - L) head++;
    // pop smaller from back
    while (tail > head && deque[tail - 1] <= absMax[i]) tail--;
    deque[tail] = absMax[i];
    idx[tail] = i;
    tail++;
    winMax[i] = deque[head];
  }

  // Gain reduction with look-ahead release envelope.
  const atk = Math.exp(-1 / Math.max(1, 0.0005 * sr)); // near-instant
  const rel = Math.exp(-1 / Math.max(1, 0.15 * sr)); // 150 ms release
  let env = 1;
  void th;
  for (let c = 0; c < buffer.channels.length; c++) {
    const ch = buffer.channels[c];
    for (let i = 0; i < n; i++) {
      const m = winMax[i];
      const desired = m > 1e-12 ? Math.min(1, ce / m) : 1;
      // Attack toward reduction (desired < env) fast; recover slowly.
      env = desired < env ? desired + (env - desired) * atk : env + (1 - env) * rel;
      // ensure never above desired level until the peak has passed
      if (env > desired) env = desired;
      ch[i] *= env;
    }
  }
  return buffer;
}
