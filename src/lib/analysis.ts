/**
 * analysis.ts
 *
 * Real measurement of PCM audio, using the same DSP primitives as the
 * mastering engine. Everything here runs on the user's own decoded audio —
 * no synthetic data is ever substituted.
 */

import {
  measureLufs as engineMeasureLufs,
  measureTruePeak as engineMeasureTruePeak,
  type PcmData,
} from "./client-audio-engine";

export interface Metrics {
  /** Integrated loudness, LUFS (ITU-R BS.1770-4 approximation, gated). */
  lufs: number;
  /** True peak in dBTP (4x oversampled detection). */
  truePeakDb: number;
  /** Dynamic range, dB (95th–5th percentile spread of 400 ms block RMS). */
  dynamicRange: number;
  /** Stereo width 0-100% (correlation-based; mono = 0, fully-wide = 100). */
  stereoWidth: number;
}

export interface PartialProgress {
  (fraction: number): void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** LUFS, yielding to the event loop once so the UI can repaint first. */
async function measureLufsAsync(pcm: PcmData): Promise<number> {
  await tick();
  return engineMeasureLufs(pcm);
}

/** True peak (linear -> dBTP), chunked so long files do not freeze the tab. */
async function measureTruePeakAsync(
  pcm: PcmData,
  onProgress?: PartialProgress
): Promise<number> {
  const OS = 4;
  let peak = 0;
  let done = 0;
  const chunk = 2_000_000; // samples per channel per pass

  for (const ch of pcm.channels) {
    for (let i = 0; i < ch.length - 1; i += chunk) {
      const end = Math.min(i + chunk, ch.length - 1);
      for (let j = i; j < end; j++) {
        const a = ch[j];
        const b = ch[j + 1];
        const aAbs = Math.abs(a);
        if (aAbs > peak) peak = aAbs;
        for (let k = 1; k < OS; k++) {
          const t = k / OS;
          const v = Math.abs(a + (b - a) * t);
          if (v > peak) peak = v;
        }
      }
      const last = Math.abs(ch[ch.length - 1] || 0);
      if (last > peak) peak = last;
      done += end - i;
      onProgress?.(Math.min(1, (done * pcm.channels.length) / (ch.length * pcm.channels.length)));
      await tick();
    }
  }

  return peak > 0 ? 20 * Math.log10(peak) : -120;
}

/**
 * Dynamic range + stereo width in one pass, chunked for the UI.
 *
 * - DR: 400 ms block RMS in dB; DR = p95 - p5 of the block distribution
 *   (a practical, transparent proxy for LRA).
 * - Width: average L/R correlation mapped to 0-100% (mono ≈ 0, decorrelated ≈ 100).
 */
async function measureDrAndWidthAsync(
  pcm: PcmData,
  onProgress?: PartialProgress
): Promise<{ dynamicRange: number; stereoWidth: number }> {
  const [l, r] = pcm.channels;
  const n = l.length;
  if (n < 1024) return { dynamicRange: 0, stereoWidth: pcm.channels.length < 2 ? 0 : 50 };

  const block = Math.max(2048, Math.floor(pcm.sampleRate * 0.4));
  const numBlocks = Math.ceil(n / block);
  const blockDb = new Float32Array(numBlocks);

  let corrSum = 0;
  let corrCount = 0;

  const chunkBlocks = Math.max(1, Math.floor(numBlocks / 40));

  for (let b = 0; b < numBlocks; b += chunkBlocks) {
    const bEnd = Math.min(b + chunkBlocks, numBlocks);
    for (let bi = b; bi < bEnd; bi++) {
      const start = bi * block;
      const end = Math.min(start + block, n);
      let sumL = 0;
      let sumR = 0;
      for (let i = start; i < end; i++) {
        const x = l[i];
        const y = r[i];
        sumL += x * x;
        sumR += y * y;
      }
      const rms = Math.sqrt((sumL + sumR) / (2 * (end - start)));
      blockDb[bi] = rms > 1e-9 ? 20 * Math.log10(rms) : -120;
    }

    // Correlation over the same span (mono signal: corr ≈ 1 -> width 0).
    const s0 = b * block;
    const s1 = Math.min(s0 + chunkBlocks * block, n - 1);
    let dot = 0;
    let dotL = 0;
    let dotR = 0;
    for (let i = s0; i < s1; i += 16) {
      const x = l[i];
      const y = r[i];
      dot += x * y;
      dotL += x * x;
      dotR += y * y;
    }
    const denom = Math.sqrt(dotL * dotR);
    if (denom > 1e-9) {
      corrSum += dot / denom;
      corrCount++;
    }

    onProgress?.(bEnd / numBlocks);
    await tick();
  }

  // Percentile spread of block RMS (ignore fully silent blocks).
  const active = Array.from(blockDb)
    .filter((v) => v > -100)
    .sort((a, b) => a - b);
  let dynamicRange = 0;
  if (active.length >= 4) {
    const p = (q: number) => active[Math.min(active.length - 1, Math.floor(q * (active.length - 1)))];
    dynamicRange = Math.max(0, p(0.95) - p(0.05));
  }

  const corr = corrCount > 0 ? Math.min(1, Math.max(-1, corrSum / corrCount)) : 1;
  const stereoWidth = Math.round(Math.min(1, Math.max(0, (1 - corr) / 2)) * 100);

  return { dynamicRange, stereoWidth };
}

/** Full metrics bundle. Yields between measurements so the UI stays alive. */
export async function measureAll(
  pcm: PcmData,
  onProgress?: PartialProgress
): Promise<Metrics> {
  let lufs = -120;
  let tp = 0;
  let drw = { dynamicRange: 0, stereoWidth: 0 };
  let completed = 0;
  const total = 3;

  lufs = await measureLufsAsync(pcm);
  completed++;
  onProgress?.(completed / total);

  tp = await measureTruePeakAsync(pcm, (f) =>
    onProgress?.((completed + f) / total)
  );
  completed++;
  onProgress?.(completed / total);

  drw = await measureDrAndWidthAsync(pcm, (f) =>
    onProgress?.((completed + f) / total)
  );

  return {
    lufs,
    truePeakDb: tp,
    dynamicRange: drw.dynamicRange,
    stereoWidth: drw.stereoWidth,
  };
}
