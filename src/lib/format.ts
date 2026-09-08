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

/** "≈ 12s" style ETA. Returns "—" for unknown/near-zero estimates. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `≈ ${Math.max(1, Math.round(seconds))}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `≈ ${m}m ${s.toString().padStart(2, "0")}s left`;
}

/** Human label for a mixing intensity value (0-100). */
export function intensityLabel(v: number): string {
  if (v < 25) return "Gentle";
  if (v < 50) return "Balanced";
  if (v < 75) return "Punchy";
  return "Aggressive";
}
