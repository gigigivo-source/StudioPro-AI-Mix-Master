/**
 * file-loader.ts
 *
 * Safe streaming file loader, validator, and ZIP extractor with real-time
 * progress tracking, transfer speed calculation, ETA estimation, and cancellation.
 */

import JSZip from "jszip";
import type { TrackInfo, UploadProgress } from "./types";
import { formatBytes } from "./format";

export const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

export const SUPPORTED_AUDIO_EXTS = [
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".m4a",
  ".aac",
  ".aiff",
  ".aif",
  ".opus",
  ".webm",
];

export const SUPPORTED_EXTS = [...SUPPORTED_AUDIO_EXTS, ".zip"];

export const MIME_BY_EXTENSION: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
};

/** Get file extension in lower case, e.g. ".wav". */
export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/** Check whether a file or filename has a supported audio extension. */
export function isSupportedAudio(nameOrExt: string): boolean {
  const ext = nameOrExt.startsWith(".") ? nameOrExt.toLowerCase() : getExtension(nameOrExt);
  return SUPPORTED_AUDIO_EXTS.includes(ext);
}

/** Check whether a file or filename is a ZIP. */
export function isZipFile(fileOrName: File | string): boolean {
  if (typeof fileOrName === "string") {
    return getExtension(fileOrName) === ".zip";
  }
  const ext = getExtension(fileOrName.name);
  return ext === ".zip" || fileOrName.type.includes("zip");
}

/** Validate file size and format before reading. */
export function validateFile(file: File): { valid: boolean; error?: string; isZip: boolean } {
  if (!file) {
    return { valid: false, error: "No file selected.", isZip: false };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File exceeds the 1 GB limit (${formatBytes(file.size)}). Please select a file under 1 GB.`,
      isZip: isZipFile(file),
    };
  }

  const isZip = isZipFile(file);
  const isAudio = isSupportedAudio(file.name) || (file.type && file.type.startsWith("audio/"));

  if (!isZip && !isAudio) {
    return {
      valid: false,
      error: `Unsupported file format “${file.name}”. Supported formats: WAV, MP3, FLAC, OGG, M4A, AAC, AIFF, AIF, ZIP.`,
      isZip: false,
    };
  }

  return { valid: true, isZip };
}

/** Helper to yield event loop */
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read a File into an ArrayBuffer with real streaming progress, transfer speed (MB/s),
 * ETA calculation, and cancellation support.
 */
export async function readFileWithProgress(
  file: File,
  options?: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<ArrayBuffer> {
  const total = file.size;
  const signal = options?.signal;

  if (signal?.aborted) {
    throw new DOMException("Upload cancelled by user", "AbortError");
  }

  // If stream() API is available, stream chunk by chunk
  if (typeof file.stream === "function") {
    const stream = file.stream();
    const reader = stream.getReader();

    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const startTime = performance.now();
    let lastReportTime = startTime;
    let lastLoaded = 0;
    let speedMBs = 0;

    try {
      while (true) {
        if (signal?.aborted) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new DOMException("Upload cancelled by user", "AbortError");
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
        }

        const now = performance.now();
        const dt = now - lastReportTime;

        if (dt > 80 || loaded >= total) {
          const totalElapsedSec = (now - startTime) / 1000;
          const instSpeedMBs = totalElapsedSec > 0 ? (loaded / (1024 * 1024)) / totalElapsedSec : 0;
          speedMBs = speedMBs === 0 ? instSpeedMBs : speedMBs * 0.7 + instSpeedMBs * 0.3;

          const remainingBytes = Math.max(0, total - loaded);
          const etaSec = speedMBs > 0 ? remainingBytes / (speedMBs * 1024 * 1024) : null;
          const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 100;

          options?.onProgress?.({
            loaded,
            total,
            percent,
            speedMBs,
            etaSec,
            stage: "reading",
            message: total > 50 * 1024 * 1024 ? "Uploading & reading file…" : "Reading file…",
          });

          lastReportTime = now;
          lastLoaded = loaded;
          await tick(0);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks into single ArrayBuffer
    const combined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined.buffer;
  }

  // Fallback using FileReader with chunk slicing
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();

    if (signal) {
      signal.addEventListener("abort", () => {
        reader.abort();
        reject(new DOMException("Upload cancelled by user", "AbortError"));
      });
    }

    const startTime = performance.now();

    reader.onprogress = (e) => {
      if (e.lengthComputable && options?.onProgress) {
        const loaded = e.loaded;
        const total = e.total;
        const now = performance.now();
        const elapsed = (now - startTime) / 1000;
        const speedMBs = elapsed > 0 ? (loaded / (1024 * 1024)) / elapsed : 0;
        const remaining = Math.max(0, total - loaded);
        const etaSec = speedMBs > 0 ? remaining / (speedMBs * 1024 * 1024) : null;
        options.onProgress({
          loaded,
          total,
          percent: (loaded / total) * 100,
          speedMBs,
          etaSec,
          stage: "reading",
          message: "Reading file…",
        });
      }
    };

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file as ArrayBuffer"));
      }
    };

    reader.onerror = () => {
      reject(new Error(reader.error?.message || "Failed to read file"));
    };

    reader.onabort = () => {
      reject(new DOMException("Upload cancelled by user", "AbortError"));
    };

    reader.readAsArrayBuffer(file);
  });
}

export interface RawAudioEntry {
  name: string;
  data: ArrayBuffer;
}

/**
 * Extract audio entries from an ArrayBuffer (single audio or ZIP).
 */
export async function extractAudioEntries(
  arrayBuffer: ArrayBuffer,
  fileName: string,
  options?: {
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
  }
): Promise<RawAudioEntry[]> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new DOMException("Loading cancelled by user", "AbortError");
  }

  const isZip = isZipFile(fileName);
  const total = arrayBuffer.byteLength;

  if (!isZip) {
    return [{ name: fileName, data: arrayBuffer }];
  }

  options?.onProgress?.({
    loaded: total,
    total,
    percent: 100,
    speedMBs: 0,
    etaSec: null,
    stage: "extracting",
    message: "Scanning ZIP archive…",
  });

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (err) {
    throw new Error(
      "The ZIP archive appears corrupted or cannot be read. Please check the archive and try again."
    );
  }

  if (signal?.aborted) {
    throw new DOMException("Loading cancelled by user", "AbortError");
  }

  const validEntries: { path: string; entry: JSZip.JSZipObject }[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (path.includes("__MACOSX") || path.includes(".DS_Store") || path.startsWith(".")) {
      continue;
    }
    const ext = getExtension(path);
    if (SUPPORTED_AUDIO_EXTS.includes(ext)) {
      validEntries.push({ path, entry });
    }
  }

  if (validEntries.length === 0) {
    throw new Error(
      "No supported audio tracks found in this ZIP. Supported formats: WAV, MP3, FLAC, OGG, M4A, AAC, AIFF."
    );
  }

  const raw: RawAudioEntry[] = [];
  for (let i = 0; i < validEntries.length; i++) {
    if (signal?.aborted) {
      throw new DOMException("Loading cancelled by user", "AbortError");
    }

    const { path, entry } = validEntries[i];
    const trackName = path.split("/").pop() || path;

    options?.onProgress?.({
      loaded: total,
      total,
      percent: Math.round(((i + 1) / validEntries.length) * 100),
      speedMBs: 0,
      etaSec: null,
      stage: "extracting",
      message: `Extracting stem ${i + 1} of ${validEntries.length} (${trackName})…`,
    });

    try {
      const data = await entry.async("arraybuffer");
      raw.push({ name: trackName, data });
    } catch {
      // Ignore individual corrupted zip entries if others exist
    }

    await tick(10);
  }

  if (raw.length === 0) {
    throw new Error("Could not extract any audio files from this ZIP.");
  }

  return raw;
}
