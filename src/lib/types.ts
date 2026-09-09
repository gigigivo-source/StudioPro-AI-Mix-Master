import type { PcmData } from "./client-audio-engine";
import type { Metrics } from "./analysis";

/** Top-level app phases. */
export type Phase = "idle" | "loading" | "ready" | "processing" | "done";

export type Stage = "mixing" | "mastering" | "qc";

export interface Settings {
  /** Engine genre key: POP, HIP_HOP, EDM, ROCK, ACOUSTIC, CLASSICAL, JAZZ, METAL, R_AND_B, LO_FI */
  genre: string;
  /** Engine loudness key: SPOTIFY, APPLE_MUSIC, YOUTUBE, CD */
  loudness: string;
  /** 0 - 100 */
  intensity: number;
  vocalFocus: boolean;
}

export interface TrackInfo {
  name: string;
  /** Bytes. */
  size: number;
  /** Seconds. */
  duration: number;
  sampleRate: number;
  /** Blob URL for raw preview playback. */
  url: string;
  /** Encoded file bytes — re-decoded one stem at a time during mix. */
  data: ArrayBuffer;
}

export interface Project {
  fileName: string;
  fileSize: number;
  tracks: TrackInfo[];
  /** Duration of the summed master bus (seconds). */
  totalDuration: number;
}

export interface MasterSession {
  settings: Settings;
  originalPcm: PcmData;
  originalUrl: string;
  masteredPcm: PcmData;
  masteredUrl: string;
  before: Metrics;
  after: Metrics;
  durationSec: number;
  sampleRate: number;
  elapsedSec: number;
  tracks: { name: string; data: ArrayBuffer }[];
}

export type Theme = "dark" | "light";
