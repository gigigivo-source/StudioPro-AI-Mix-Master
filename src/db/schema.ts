import { pgTable, text, timestamp, integer, boolean, jsonb, real } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  originalZipName: text("original_zip_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  status: text("status").notNull().default("uploaded"), // uploaded, analyzing, processing, completed, failed
  bpm: real("bpm"),
  musicalKey: text("musical_key"),
  timeSignature: text("time_signature").default("4/4"),
  flmParsed: boolean("flm_parsed").default(false),
  parserUsed: text("parser_used").default("FLM Binary / Header Inspector"),
  engineUsed: text("engine_used").default("RoEx Tonn API (Auto-fallback to libsonare DSP)"),
  musicalStyle: text("musical_style").default("HIP_HOP"),
  desiredLoudness: text("desired_loudness").default("MEDIUM"),
  targetLufs: real("target_lufs").default(-14.0),
  intensity: integer("intensity").default(75),
  vocalFocus: boolean("vocal_focus").default(true),
  matchReference: boolean("match_reference").default(false),
  returnStems: boolean("return_stems").default(true),
  passQc: boolean("pass_qc").default(true),
  qcAttempts: integer("qc_attempts").default(1),
  qcReport: jsonb("qc_report"),
  tracksMeta: jsonb("tracks_meta"), // array of tracks extracted from zip
  analysisSummary: jsonb("analysis_summary"),
  masterMetrics: jsonb("master_metrics"),
  originalMetrics: jsonb("original_metrics"),
  // URLs or synthetic render identifiers
  originalAudioUrl: text("original_audio_url"),
  masterAudioUrl: text("master_audio_url"),
  stemsDownloadUrl: text("stems_download_url"),
});

export const processingLogs = pgTable("processing_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  stage: text("stage").notNull(), // extract, analyze, upload_roex, mix, master, qc, complete
  message: text("message").notNull(),
  level: text("level").default("info"), // info, success, warning, error
  details: jsonb("details"),
});
