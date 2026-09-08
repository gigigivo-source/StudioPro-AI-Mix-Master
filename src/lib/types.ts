import type { PcmData } from "./client-audio-engine";
import type { Metrics } from "./analysis";

/** Top-level app phases. */
export type Phase = "idle" | "loading" | "ready" | "processing" | "done" | "batch";

export type Stage = "mixing" | "mastering" | "qc";

export type AccentColor = "purple" | "cyan" | "green" | "orange" | "pink";

export interface Settings {
  /** Engine genre key: POP, HIP_HOP, EDM, ROCK, ACOUSTIC, CLASSICAL, JAZZ, METAL, R_AND_B, LO_FI */
  genre: string;
  /** Engine loudness key: SPOTIFY, APPLE_MUSIC, YOUTUBE, CD */
  loudness: string;
  /** 0 - 100 */
  intensity: number;
  vocalFocus: boolean;
  accentColor?: AccentColor;
  volume?: number;
}

export interface TrackInfo {
  name: string;
  /** Bytes. */
  size: number;
  /** Seconds. */
  duration: number;
  /** Blob URL for raw preview playback. */
  url: string;
  buffer: AudioBuffer;
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
  tracks: { name: string; buffer: AudioBuffer }[];
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
  speedMBs: number;
  etaSec: number | null;
  stage: "reading" | "extracting" | "decoding";
  message: string;
}

export interface BatchItem {
  id: string;
  file: File;
  name: string;
  size: number;
  duration?: number;
  status: "idle" | "queued" | "processing" | "done" | "error";
  progress: number;
  error?: string;
  session?: MasterSession;
  masteredBlob?: Blob;
}

export interface BatchState {
  items: BatchItem[];
  currentIndex: number;
  isProcessing: boolean;
}

export type Theme = "dark" | "light";
