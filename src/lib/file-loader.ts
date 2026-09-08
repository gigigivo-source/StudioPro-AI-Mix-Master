/**
 * file-loader.ts
 *
 * Memory-safe file loading for the StudioPro pipeline. The rules enforced
 * here are the core of the "no Aw, Snap!" fix:
 *
 *  1. WAV files are NEVER read with `file.arrayBuffer()`. They are parsed by
 *     streaming small `file.slice()` chunks (32 MiB by default) straight
 *     into the pre-allocated Float32 channel arrays — at no point do the
 *     full raw bytes and the decoded audio live in memory at the same time.
 *  2. Non-WAV formats (MP3/FLAC/OGG/…) must be decoded by the Web Audio API,
 *     which requires the full byte stream. `file.arrayBuffer()` /
 *     `arraybuffer` extraction is therefore called for those only, and the
 *     bytes are dropped as soon as the samples are copied out.
 *  3. Every conversion loop yields to the event loop so the UI stays
 *     responsive and the renderer can collect garbage between steps.
 *
 * This module also provides:
 *  - device memory budgets + verdicts (the large-file guard shown before
 *    processing and enforced while loading),
 *  - pre-computed waveform peaks (hard-capped at 2000 points per channel —
 *    the A/B waveform renders from these and never decodes the audio),
 *  - a compact preview WAV builder (22.05 kHz / 16-bit) used for low-memory
 *    playback previews instead of the raw multi-hundred-MB blobs.
 */

import { encodeWav, toStereo, type PcmData } from "./client-audio-engine";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const tag4 = (view: DataView, offset: number) =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );

/* ------------------------------------------------------------------ */
/* WAV header (streamed — only the front of the file is read)          */
/* ------------------------------------------------------------------ */

export interface WavHeaderInfo {
  format: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  totalFrames: number;
  durationSec: number;
  /** Estimated decoded float32 PCM size in bytes (frames × channels × 4). */
  pcmBytes: number;
}

interface RiffWalk {
  format: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  /** True when the walk ended because of the prefix boundary. */
  truncated: boolean;
}

/** Walk the RIFF chunk directory inside `dv` (which covers `prefixLen` bytes). */
function walkRiff(dv: DataView, prefixLen: number, riffStart: number): RiffWalk {
  const out: RiffWalk = {
    format: 0,
    numChannels: 0,
    sampleRate: 0,
    bitsPerSample: 0,
    dataOffset: -1,
    dataLength: 0,
    truncated: false,
  };
  let offset = riffStart + 12;
  while (offset + 8 <= prefixLen) {
    const id = tag4(dv, offset);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= prefixLen) {
      out.format = dv.getUint16(body, true);
      out.numChannels = dv.getUint16(body + 2, true);
      out.sampleRate = dv.getUint32(body + 4, true);
      out.bitsPerSample = dv.getUint16(body + 14, true);
    } else if (id === "data") {
      out.dataOffset = body;
      out.dataLength = size;
    }

    // Chunks are word-aligned; the body can be skipped by its declared size.
    offset = body + size + (size % 2);
    if (out.format !== 0 && out.dataOffset !== -1) break;
  }
  out.truncated = offset + 8 > prefixLen && (out.format === 0 || out.dataOffset === -1);
  return out;
}

function validateWavInfo(w: RiffWalk, fileEnd: number): WavHeaderInfo {
  if (w.format === 0) throw new Error("WAV missing fmt chunk");
  if (w.dataOffset < 0) throw new Error("WAV missing data chunk");
  if (w.numChannels <= 0) throw new Error("WAV has zero channels");
  if (w.sampleRate <= 0) throw new Error("WAV has invalid sample rate");

  const bytesPerSample = w.bitsPerSample / 8;
  const frameSize = bytesPerSample * w.numChannels;
  if (frameSize <= 0) throw new Error("WAV has invalid bit depth");

  // The data chunk size can be wrong (truncated/padded writers) — clamp it
  // to what is actually in the file. dataOffset is absolute.
  const dataLength = Math.max(0, Math.min(w.dataLength, fileEnd - w.dataOffset));
  const totalFrames = Math.floor(dataLength / frameSize);
  if (totalFrames <= 0) throw new Error("WAV contains no audio frames");

  return {
    format: w.format,
    numChannels: w.numChannels,
    sampleRate: w.sampleRate,
    bitsPerSample: w.bitsPerSample,
    dataOffset: w.dataOffset,
    dataLength,
    totalFrames,
    durationSec: totalFrames / w.sampleRate,
    pcmBytes: totalFrames * w.numChannels * 4,
  };
}

/**
 * Read only the RIFF/WAVE header of a file (a few hundred KB at most), so the
 * decoded size can be estimated *before* any audio data is parsed.
 * Tolerates an optional ID3v2 tag in front of the RIFF block.
 */
export async function readWavHeader(file: Blob): Promise<WavHeaderInfo> {
  if (file.size < 12) throw new Error("File too small to be a WAV");

  // Locate the RIFF start (possibly after an ID3v2 prefix).
  const headBuf = await file.slice(0, 12).arrayBuffer();
  const head = new DataView(headBuf);
  let riffStart = 0;
  if (tag4(head, 0).slice(0, 3) === "ID3") {
    const s = head;
    const id3Size =
      ((s.getUint8(6) & 0x7f) << 21) |
      ((s.getUint8(7) & 0x7f) << 14) |
      ((s.getUint8(8) & 0x7f) << 7) |
      (s.getUint8(9) & 0x7f);
    riffStart = 10 + id3Size;
    if (file.size < riffStart + 12) throw new Error("File too small to be a WAV");
    const riffBuf = await file.slice(riffStart, riffStart + 12).arrayBuffer();
    const rv = new DataView(riffBuf);
    if (tag4(rv, 0) !== "RIFF" || tag4(rv, 8) !== "WAVE") {
      throw new Error("Not a valid RIFF/WAVE file");
    }
  } else if (tag4(head, 0) !== "RIFF" || tag4(head, 8) !== "WAVE") {
    throw new Error("Not a valid RIFF/WAVE file");
  }

  // Read progressively larger prefixes until fmt + data are both found.
  for (const prefix of [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
    const len = Math.min(file.size, prefix);
    const dv = new DataView(await file.slice(0, len).arrayBuffer());
    const w = walkRiff(dv, len, riffStart);
    if (!w.truncated || w.format !== 0 && w.dataOffset !== -1) {
      return validateWavInfo(w, file.size);
    }
  }
  throw new Error("WAV header too large to parse");
}

/* ------------------------------------------------------------------ */
/* WAV data conversion (shared by the streaming parser and ZIP decode) */
/* ------------------------------------------------------------------ */

/**
 * Convert one contiguous slice of the WAV data chunk (interleaved frames)
 * into the pre-allocated channel arrays. `slice` is a fresh ArrayBuffer, so
 * typed-array views are always correctly aligned.
 */
function decodeWavSlice(
  slice: ArrayBuffer,
  channels: Float32Array[],
  outOffset: number,
  frames: number,
  bitsPerSample: number,
  isFloat: boolean
): void {
  const numChannels = channels.length;

  if (bitsPerSample === 8) {
    const u8 = new Uint8Array(slice);
    for (let i = 0; i < frames; i++) {
      let pos = i * numChannels;
      for (let c = 0; c < numChannels; c++) {
        channels[c][outOffset + i] = (u8[pos + c] - 128) / 128;
      }
    }
  } else if (bitsPerSample === 16) {
    const i16 = new Int16Array(slice);
    for (let i = 0; i < frames; i++) {
      let pos = i * numChannels;
      for (let c = 0; c < numChannels; c++) {
        channels[c][outOffset + i] = i16[pos + c] / 32768;
      }
    }
  } else if (bitsPerSample === 24) {
    const view = new DataView(slice);
    for (let i = 0; i < frames; i++) {
      let pos = i * numChannels * 3;
      for (let c = 0; c < numChannels; c++) {
        const b0 = view.getUint8(pos);
        const b1 = view.getUint8(pos + 1);
        const b2 = view.getUint8(pos + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        channels[c][outOffset + i] = v / 8388608;
        pos += 3;
      }
    }
  } else if (bitsPerSample === 32) {
    if (isFloat) {
      const f32 = new Float32Array(slice);
      for (let i = 0; i < frames; i++) {
        let pos = i * numChannels;
        for (let c = 0; c < numChannels; c++) {
          channels[c][outOffset + i] = f32[pos + c];
        }
      }
    } else {
      const i32 = new Int32Array(slice);
      for (let i = 0; i < frames; i++) {
        let pos = i * numChannels;
        for (let c = 0; c < numChannels; c++) {
          channels[c][outOffset + i] = i32[pos + c] / 2147483648;
        }
      }
    }
  } else if (bitsPerSample === 64) {
    const f64 = new Float64Array(slice);
    for (let i = 0; i < frames; i++) {
      let pos = i * numChannels;
      for (let c = 0; c < numChannels; c++) {
        channels[c][outOffset + i] = f64[pos + c];
      }
    }
  } else {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }
}

/* ------------------------------------------------------------------ */
/* Streaming WAV parser                                                */
/* ------------------------------------------------------------------ */

export interface ParseWavStreamingOptions {
  /** Called with 0..1 as the audio data chunk is consumed. */
  onProgress?: (fraction: number) => void;
  /** Bytes read per file slice (default 32 MiB). */
  chunkBytes?: number;
}

export interface ParsedWav {
  pcm: PcmData;
  header: WavHeaderInfo;
}

/**
 * Parse a WAV file without ever holding the whole file in memory: the audio
 * data chunk is consumed in `chunkBytes` slices and converted directly into
 * the pre-allocated Float32 channel arrays. Peak memory ≈ decoded PCM + one
 * slice, instead of raw bytes + decoded audio + copies.
 */
export async function parseWavStreaming(
  file: Blob,
  opts: ParseWavStreamingOptions = {}
): Promise<ParsedWav> {
  const header = await readWavHeader(file);
  const {
    numChannels,
    sampleRate,
    bitsPerSample,
    format,
    dataOffset,
    totalFrames,
  } = header;

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(totalFrames));

  const frameSize = (bitsPerSample / 8) * numChannels;
  const chunkBytes = Math.max(frameSize, opts.chunkBytes ?? 32 * 1024 * 1024);
  const chunkFrames = Math.max(1, Math.floor(chunkBytes / frameSize));
  const isFloat = format === 3 || format === 0xfffe;

  let done = 0;
  while (done < totalFrames) {
    const frames = Math.min(chunkFrames, totalFrames - done);
    const slice = await file
      .slice(dataOffset + done * frameSize, dataOffset + (done + frames) * frameSize)
      .arrayBuffer();
    decodeWavSlice(slice, channels, done, frames, bitsPerSample, isFloat);
    done += frames;
    opts.onProgress?.(done / totalFrames);
    // Let the UI repaint and the GC run between slices.
    await yieldToUi();
  }

  return { pcm: { sampleRate, channels }, header };
}

/* ------------------------------------------------------------------ */
/* WAV decode of an already-extracted byte array (ZIP entries)         */
/* ------------------------------------------------------------------ */

/**
 * Decode a WAV entry that was already extracted from a ZIP (one entry at a
 * time). The byte array is converted in 32 MiB frame chunks with yields so a
 * very large stem cannot freeze the tab; the caller drops `data` afterwards.
 */
export async function decodeWavBytes(
  data: ArrayBuffer,
  opts: ParseWavStreamingOptions = {}
): Promise<ParsedWav> {
  const dv = new DataView(data);
  let riffStart = 0;
  if (data.byteLength >= 12) {
    if (tag4(dv, 0).slice(0, 3) === "ID3") {
      const id3Size =
        ((dv.getUint8(6) & 0x7f) << 21) |
        ((dv.getUint8(7) & 0x7f) << 14) |
        ((dv.getUint8(8) & 0x7f) << 7) |
        (dv.getUint8(9) & 0x7f);
      riffStart = 10 + id3Size;
    }
    if (data.byteLength < riffStart + 12) throw new Error("File too small to be a WAV");
    if (tag4(dv, riffStart) !== "RIFF" || tag4(dv, riffStart + 8) !== "WAVE") {
      throw new Error("Not a valid RIFF/WAVE file");
    }
  }

  const w = walkRiff(dv, data.byteLength, riffStart);
  const header = validateWavInfo(w, data.byteLength);

  const { numChannels, sampleRate, bitsPerSample, format, dataOffset, totalFrames } = header;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(totalFrames));

  const frameSize = (bitsPerSample / 8) * numChannels;
  const chunkBytes = Math.max(frameSize, opts.chunkBytes ?? 32 * 1024 * 1024);
  const chunkFrames = Math.max(1, Math.floor(chunkBytes / frameSize));
  const isFloat = format === 3 || format === 0xfffe;

  // Convert in chunks with yields so a very large stem cannot freeze the
  // tab. `data.slice()` is a transient 32 MiB copy (the entry's bytes are
  // already fully in memory from the ZIP extraction and are dropped by the
  // caller right after this returns).
  for (let done = 0; done < totalFrames; done += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - done);
    // dataOffset is absolute within the buffer (walkRiff walks from riffStart).
    const off = dataOffset + done * frameSize;
    const sub = data.slice(off, off + frames * frameSize);
    decodeWavSlice(sub, channels, done, frames, bitsPerSample, isFloat);
    opts.onProgress?.(Math.min(1, (done + frames) / totalFrames));
    await yieldToUi();
  }

  return { pcm: { sampleRate, channels }, header };
}

/* ------------------------------------------------------------------ */
/* Non-WAV decoding (Web Audio)                                        */
/* ------------------------------------------------------------------ */

function bufferToPcm(buffer: AudioBuffer): { pcm: PcmData; durationSec: number } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    // Copy: getChannelData returns a live view in some engines, and the
    // AudioBuffer itself must become unreachable so it can be GC'd.
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  return { pcm: { sampleRate: buffer.sampleRate, channels }, durationSec: buffer.duration };
}

/**
 * Decode a non-WAV audio file (MP3/FLAC/OGG/M4A/…). Web Audio decoding needs
 * the full byte stream, so this is the ONLY place a full `file.arrayBuffer()`
 * happens — and only for non-WAV files. The raw bytes are dropped as soon as
 * the samples are copied into PCM (see bufferToPcm).
 */
export async function decodeNonWavFile(
  file: Blob,
  ctx: AudioContext
): Promise<{ pcm: PcmData; durationSec: number }> {
  const bytes = await file.arrayBuffer();
  // Copy: decodeAudioData may detach the buffer in some engines.
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  return bufferToPcm(buffer);
}

/** Same as decodeNonWavFile but for an already-extracted byte array. */
export async function decodeNonWavBytes(
  bytes: ArrayBuffer,
  ctx: AudioContext
): Promise<{ pcm: PcmData; durationSec: number }> {
  // Copy: decodeAudioData may detach the buffer in some engines.
  const buffer = await ctx.decodeAudioData(bytes.slice(0));
  return bufferToPcm(buffer);
}

/* ------------------------------------------------------------------ */
/* Memory budget + large-file guard                                    */
/* ------------------------------------------------------------------ */

export type MemoryLevel = "ok" | "warn" | "reject";

export interface MemoryVerdict {
  level: MemoryLevel;
  /** Estimated peak memory of the mastering pipeline, bytes. */
  peakBytes: number;
  /** Device budget used for the comparison, bytes. */
  budgetBytes: number;
}

export const MEMORY_WARNING_MESSAGE =
  "This file is large. Processing may take a few minutes. For best results, use a desktop browser.";
export const MEMORY_REJECT_MESSAGE =
  "This file is too large for your device. Please use a desktop browser or split the file into smaller parts.";

/**
 * Estimate the mastering pipeline's peak memory for a set of decoded tracks:
 * the resident track PCM, the mixed bus (shared with the single track via the
 * zero-copy sum fast path) plus the mastering working copy, and headroom.
 */
export function estimateProjectPeakBytes(
  tracks: { sampleRate: number; channels: Float32Array[] }[]
): number {
  let trackBytes = 0;
  let maxFrames = 0;
  for (const t of tracks) {
    const frames = t.channels[0]?.length ?? 0;
    trackBytes += frames * t.channels.length * 4;
    if (frames > maxFrames) maxFrames = frames;
  }
  // The bus is stereo at the highest input rate; mastering needs one working
  // copy of it (the original stays intact for A/B). Multi-track mixes also
  // allocate the summed bus itself.
  const busBytes = maxFrames * 2 * 4;
  const workBytes = tracks.length <= 1 ? busBytes : 2 * busBytes;
  return trackBytes + workBytes + 64 * 1024 * 1024;
}

/**
 * How much memory we are willing to give the audio pipeline.
 *
 * `navigator.deviceMemory` (Chrome, mobile & desktop) is the reliable signal
 * — we cap it at ~40% of physical RAM, leaving the rest for the OS, the
 * browser and the rest of the tab. Without the signal we assume a
 * desktop-class machine (typed arrays live outside the V8 heap, so the JS
 * heap limit is not the constraint).
 */
export function deviceMemoryBudgetBytes(): number {
  if (typeof navigator !== "undefined") {
    const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof dm === "number" && dm > 0) {
      return Math.min(dm, 16) * 1024 ** 3 * 0.4;
    }
  }
  return 6 * 1024 ** 3;
}

/**
 * Decide whether a project with the given estimated peak fits on this device.
 *  - reject: almost certainly OOMs (tab crash) — refuse to load / process.
 *  - warn:   may fit, but slow and tight — ask the user to confirm.
 */
export function memoryVerdict(
  peakBytes: number,
  budgetBytes: number = deviceMemoryBudgetBytes()
): MemoryVerdict {
  if (peakBytes > budgetBytes * 1.4) {
    return { level: "reject", peakBytes, budgetBytes };
  }
  if (peakBytes > budgetBytes) {
    return { level: "warn", peakBytes, budgetBytes };
  }
  return { level: "ok", peakBytes, budgetBytes };
}

/* ------------------------------------------------------------------ */
/* Waveform peaks (pre-computed — WaveSurfer never decodes the audio)  */
/* ------------------------------------------------------------------ */

/** Hard cap on waveform resolution: 2000 peaks per channel max. */
export const MAX_WAVEFORM_PEAKS = 2000;

/**
 * Downsample PCM into at most `maxPeaks` peak values per channel (≤ 1.0).
 * Chunked with yields so even a multi-GB master never blocks the main
 * thread. Result: ≤ 2000 points → ~16 KB per panel.
 */
export async function computePeaks(
  pcm: PcmData,
  maxPeaks: number = MAX_WAVEFORM_PEAKS
): Promise<[Float32Array, Float32Array]> {
  const n = pcm.channels[0].length;
  const peaks = Math.max(2, Math.min(maxPeaks, n));
  const step = n / peaks;
  const out: Float32Array[] = [];

  for (const ch of pcm.channels.slice(0, 2)) {
    const arr = new Float32Array(peaks);
    for (let p = 0; p < peaks; p += 256) {
      const end = Math.min(p + 256, peaks);
      for (let j = p; j < end; j++) {
        const s = Math.floor(j * step);
        const e = Math.min(n, Math.max(s + 1, Math.ceil((j + 1) * step)));
        let peak = 0;
        // Sample every Nth point inside the window — plenty for a waveform.
        const stride = Math.max(1, Math.floor((e - s) / 256));
        for (let i = s; i < e; i += stride) {
          const v = Math.abs(ch[i]);
          if (v > peak) peak = v;
        }
        arr[j] = Math.min(1, peak);
      }
      await yieldToUi();
    }
    out.push(arr);
  }
  while (out.length < 2) out.push(new Float32Array(out[0]));
  return [out[0], out[1]];
}

/* ------------------------------------------------------------------ */
/* Compact preview WAV (for playback previews)                         */
/* ------------------------------------------------------------------ */

const PREVIEW_SAMPLE_RATE = 22050;

/** Linear-interpolation resample with yields (the engine's is synchronous). */
async function resampleChunked(
  input: PcmData,
  targetRate: number,
  onProgress?: (fraction: number) => void
): Promise<PcmData> {
  const ratio = input.sampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(input.channels[0].length / ratio));
  const channels: Float32Array[] = input.channels.map(() => new Float32Array(outLength));
  const pass = Math.max(1, Math.floor((2 * 1024 * 1024) / ratio)); // ~2M input samples

  for (let start = 0; start < outLength; start += pass) {
    const end = Math.min(start + pass, outLength);
    for (let i = start; i < end; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, input.channels[0].length - 1);
      const frac = srcPos - i0;
      for (let c = 0; c < input.channels.length; c++) {
        const src = input.channels[c];
        channels[c][i] = src[i0] * (1 - frac) + src[i1] * frac;
      }
    }
    onProgress?.(end / outLength);
    await yieldToUi();
  }
  return { sampleRate: targetRate, channels };
}

/**
 * Build a compact, stream-friendly preview WAV (22.05 kHz / 16-bit stereo)
 * for A/B and per-track playback previews. ~90 KB/s (≈ 5.4 MB per minute of
 * audio) instead of the full-rate source — the browser streams it through
 * the <audio> element without decoding anything into JS memory.
 */
export async function buildPreviewWav(
  pcm: PcmData,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  const resampled =
    pcm.sampleRate === PREVIEW_SAMPLE_RATE ? pcm : await resampleChunked(pcm, PREVIEW_SAMPLE_RATE, onProgress);
  const stereo = toStereo(resampled);
  const out: PcmData = {
    sampleRate: PREVIEW_SAMPLE_RATE,
    channels: [stereo.channels[0], stereo.channels[1] ?? stereo.channels[0]],
  };
  return new Blob([encodeWav(out, 16)], { type: "audio/wav" });
}
