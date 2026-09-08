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

/**
 * A loaded track. The decoded PCM is the single source of truth — there is
 * no AudioBuffer and no raw-byte copy kept alongside it. Playback preview
 * URLs are generated lazily (see file-loader.buildPreviewWav) and revoked
 * when they are no longer needed.
 */
export interface TrackInfo {
  name: string;
  /** Bytes. */
  size: number;
  /** Seconds. */
  duration: number;
  /** Decoded float32 PCM (the only copy of the audio we keep). */
  pcm: PcmData;
}

export interface Project {
  fileName: string;
  fileSize: number;
  tracks: TrackInfo[];
  /** Duration of the summed master bus (seconds). */
  totalDuration: number;
}

/**
 * A finished mastering session. The two PCM buffers are the working set for
 * A/B comparison and exports. Preview URLs and waveform peaks are resolved
 * lazily by the results dashboard (never created eagerly) so that a large
 * master does not add multi-hundred-MB blobs to memory on completion.
 */
export interface MasterSession {
  settings: Settings;
  originalPcm: PcmData;
  masteredPcm: PcmData;
  before: Metrics;
  after: Metrics;
  durationSec: number;
  sampleRate: number;
  elapsedSec: number;
  tracks: { name: string; pcm: PcmData }[];
}

export type Theme = "dark" | "light";
