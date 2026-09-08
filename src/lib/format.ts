/** Small formatting helpers shared across the UI. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0.0 MB/s";
  const mbPerSec = bytesPerSec / (1024 * 1024);
  if (mbPerSec >= 1) {
    return `${mbPerSec.toFixed(1)} MB/s`;
  }
  const kbPerSec = bytesPerSec / 1024;
  return `${kbPerSec.toFixed(0)} KB/s`;
}

/** Seconds -> "m:ss" (or "h:mm:ss" for long material). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ss = s.toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

export function formatLufs(v: number): string {
  if (!Number.isFinite(v) || v <= -119) return "−∞";
  return `${v.toFixed(1)}`;
}

export function formatDb(v: number): string {
  if (!Number.isFinite(v) || v <= -119) return "−∞";
  return `${v.toFixed(1)}`;
}

/** "≈ 1 min 20 sec remaining" / "≈ 45 sec remaining" style ETA. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "Calculating…";
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `≈ ${s} sec remaining`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (s === 0) {
    return `≈ ${m} min remaining`;
  }
  return `≈ ${m} min ${s} sec remaining`;
}

/** Human label for a mixing intensity value (0-100). */
export function intensityLabel(v: number): string {
  if (v < 25) return "Gentle";
  if (v < 50) return "Balanced";
  if (v < 75) return "Punchy";
  return "Aggressive";
}
