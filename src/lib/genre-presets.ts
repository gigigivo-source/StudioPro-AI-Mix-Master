/**
 * genre-presets.ts
 *
 * Single source of truth for the *professional pipeline* presets — the genre
 * curves, instrument high-pass tables, loudness targets and ceilings that the
 * stage-based pipeline (audio-analysis.ts + audio-processors.ts) reads to make
 * decisions.
 *
 * NOTE: this module does NOT re-implement the DSP. The heavy bus
 * EQ / compression / saturation / imaging / limiting maths lives in
 * client-audio-engine.ts (the proven core). These tables drive the audit +
 * decision + QA layers that sit in front of and around that core.
 */

/* ------------------------------------------------------------------ *
 * Instrument categories
 * ------------------------------------------------------------------ */

export type InstrumentCategory =
  | "vocals"
  | "bass"
  | "drums"
  | "guitar"
  | "keys"
  | "synth"
  | "strings"
  | "brass"
  | "percussion"
  | "other";

/**
 * Subsonic / rumble high-pass per instrument (mirrors the professional chain
 * in the spec). Applied during per-stem subtractive cleanup so mud and rumble
 * never reach the master bus.
 */
export const CATEGORY_HPF: Record<InstrumentCategory, { freq: number; q: number; label: string }> = {
  vocals: { freq: 90, q: 0.707, label: "Vocals" },
  bass: { freq: 24, q: 0.707, label: "Bass" }, // keep the sub, cut DC rumble
  drums: { freq: 26, q: 0.707, label: "Drums" }, // kick sub stays, below is subsonic
  guitar: { freq: 90, q: 0.707, label: "Guitars" },
  keys: { freq: 70, q: 0.707, label: "Keys / Pianos" },
  synth: { freq: 60, q: 0.707, label: "Synths" },
  strings: { freq: 60, q: 0.707, label: "Strings" },
  brass: { freq: 40, q: 0.707, label: "Brass" },
  percussion: { freq: 30, q: 0.707, label: "Percussion" },
  other: { freq: 30, q: 0.707, label: "Instrument" },
};

/** Ordered list used for the audit legend and per-stem logs. */
export const CATEGORY_ORDER: InstrumentCategory[] = [
  "vocals",
  "drums",
  "bass",
  "guitar",
  "keys",
  "synth",
  "strings",
  "brass",
  "percussion",
  "other",
];

/**
 * Filename keyword -> category hints. Used by the stem audit when the user
 * does not tell us what a stem is.
 */
const NAME_HINTS: [InstrumentCategory, string[]][] = [
  ["vocals", ["vox", "vocal", "voice", "lead", "singer", "chorus", "harmony", "adlib", "vocal_", "lv"]],
  ["drums", ["drum", "kick", "snare", "hihat", "hi-hat", "hat", "cymbal", "overhead", "tom", "room"]],
  ["bass", ["bass", "808", "sub", "bassline"]],
  ["guitar", ["guitar", "gtr", "electric", "acoustic", "rhythm", "lead gtr", "strum"]],
  ["keys", ["piano", "keys", "keyboard", "rhodes", "epiano", "ep", "organ", "wurli"]],
  ["synth", ["synth", "pad", "lead synth", "pluck", "arp", "bells", "chord"]],
  ["strings", ["string", "violin", "cello", "viola", "orch", "orchestra"]],
  ["brass", ["horn", "brass", "trumpet", "sax", "trombone"]],
  ["percussion", ["perc", "shaker", "tambourine", "clap", "conga", "bongo", "snaps", "fx"]],
];

/** Guess an instrument category from a stem file name. */
export function guessCategory(fileName: string): InstrumentCategory {
  const n = fileName.toLowerCase().replace(/\.[a-z0-9]+$/i, "");
  for (const [cat, keys] of NAME_HINTS) {
    for (const k of keys) {
      if (n.includes(k)) return cat;
    }
  }
  return "other";
}

/* ------------------------------------------------------------------ *
 * Genres
 * ------------------------------------------------------------------ */

export type GenreKey =
  | "POP"
  | "HIP_HOP"
  | "EDM"
  | "ROCK"
  | "ACOUSTIC"
  | "CLASSICAL"
  | "JAZZ"
  | "METAL"
  | "R_AND_B"
  | "LO_FI";

export const GENRES: GenreKey[] = [
  "POP",
  "HIP_HOP",
  "EDM",
  "ROCK",
  "ACOUSTIC",
  "CLASSICAL",
  "JAZZ",
  "METAL",
  "R_AND_B",
  "LO_FI",
];

export const GENRE_LABELS: Record<GenreKey, string> = {
  POP: "Pop",
  HIP_HOP: "Hip-Hop",
  EDM: "EDM",
  ROCK: "Rock",
  ACOUSTIC: "Acoustic",
  CLASSICAL: "Classical",
  JAZZ: "Jazz",
  METAL: "Metal",
  R_AND_B: "R&B",
  LO_FI: "Lo-Fi",
};

/** Short "sound character" blurb per genre (used in the audit/plan). */
export const GENRE_BLURBS: Record<GenreKey, string> = {
  POP: "Bright, polished, radio-ready",
  HIP_HOP: "Heavy sub, tight punchy low end",
  EDM: "Aggressive drive, wide stereo air",
  ROCK: "Punchy mids, solid low foundation",
  ACOUSTIC: "Warm, natural, restrained",
  CLASSICAL: "Gentle — preserves dynamics and space",
  JAZZ: "Smooth, warm tonal character",
  METAL: "Dense low-mids, high drive and gain",
  R_AND_B: "Deep bass, silky top end",
  LO_FI: "Rolled-off highs, warm saturation",
};

export function normalizeGenreKey(key: string): GenreKey {
  const up = (key || "").toUpperCase() as GenreKey;
  return GENRES.includes(up) ? up : "POP";
}

export function genreLabel(key: string): string {
  return GENRE_LABELS[normalizeGenreKey(key)] ?? key.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ *
 * Loudness targets & ceilings
 * ------------------------------------------------------------------ */

export type LoudnessKey = "SPOTIFY" | "APPLE_MUSIC" | "YOUTUBE" | "CD" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Integrated loudness targets (ITU-R BS.1770-4). Kept in lock-step with the
 * DSP core's internal table so the audit/QA layer always targets what the
 * engine actually normalizes to.
 */
export const LOUDNESS_TARGETS: Record<string, number> = {
  SPOTIFY: -14.0,
  APPLE_MUSIC: -16.0,
  YOUTUBE: -14.0,
  CD: -9.0,
  LOW: -16.0,
  MEDIUM: -14.0,
  HIGH: -9.0,
};

export const LOUDNESS_LABELS: Record<string, string> = {
  SPOTIFY: "Spotify (−14 LUFS)",
  APPLE_MUSIC: "Apple Music (−16 LUFS)",
  YOUTUBE: "YouTube (−14 LUFS)",
  CD: "CD Master (−9 LUFS)",
};

export const DEFAULT_TARGET_LUFS = -14.0;

/** True-peak output ceiling (dBTP) the core brickwall holds to. */
export const MASTER_CEILING_DBTP = -1.0;

export function resolveTargetLufs(key: string): number {
  const up = (key || "").toUpperCase();
  return LOUDNESS_TARGETS[up] ?? DEFAULT_TARGET_LUFS;
}

export function loudnessLabel(key: string): string {
  return LOUDNESS_LABELS[(key || "").toUpperCase()] ?? key.replace(/_/g, " ");
}

/* ------------------------------------------------------------------ *
 * QA tolerances
 * ------------------------------------------------------------------ */

export interface QaTolerances {
  /** Allowed LUFS deviation from target, ± dB. */
  lufsToleranceDb: number;
  /** Max true peak, dBTP (must be <= this). */
  truePeakMaxDb: number;
  /** Warn (non-fatal) if correlation drops below this (0..1). */
  correlationWarn: number;
  /** Warn (non-fatal) if dynamic range collapses below this, dB. */
  dynamicRangeWarnDb: number;
  /** Soft gain applied per QA reprocess attempt (dB). */
  reprocessGainDb: number;
}

export const DEFAULT_QA_TOLERANCES: QaTolerances = {
  lufsToleranceDb: 0.5,
  truePeakMaxDb: MASTER_CEILING_DBTP,
  correlationWarn: 0.4,
  dynamicRangeWarnDb: 3.0,
  reprocessGainDb: 1.0,
};
