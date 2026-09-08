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
  /** Automatic plugin-engine report (populated when run on the AI engine). */
  auto?: SessionAuto;
}

/* ------------------------------------------------------------------ *
 * Auto plugin-engine UI report (serialisable, no audio payloads).
 * ------------------------------------------------------------------ */

export interface SessionStep {
  name: string;
  note?: string;
  params: Record<string, unknown>;
  order: number;
}

export interface SessionStem {
  name: string;
  category: string;
  categoryLabel: string;
  chainLabel: string;
  steps: SessionStep[];
}

export interface SessionQa {
  attempt: number;
  passed: boolean;
  lufs: number;
  lufsDelta: number;
  truePeakDb: number;
  correlation: number;
  dynamicRange: number;
  failures: string[];
}

export interface SessionAuto {
  bpm: number;
  warnings: string[];
  stems: SessionStem[];
  /** Master-bus plugin decisions in order. */
  masterSteps: SessionStep[];
  qa: SessionQa;
  attempts: SessionQa[];
}

export type Theme = "dark" | "light";
