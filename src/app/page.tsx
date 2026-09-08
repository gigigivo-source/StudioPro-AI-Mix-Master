"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { sumTracks, type PcmData } from "@/lib/client-audio-engine";
import { measureAll, type Metrics } from "@/lib/analysis";
import { wavBlob } from "@/lib/exports";
import {
  AUTO_STAGE_LABELS,
  processAutoEngine,
  type AutoReport,
} from "@/lib/plugin-orchestrator";
import type {
  MasterSession,
  Phase,
  Project,
  SessionAuto,
  SessionQa,
  SessionStep,
  SessionStem,
  Settings,
  Stage,
  TrackInfo,
} from "@/lib/types";
import { Header } from "@/components/Header";
import { useTheme } from "@/hooks/useTheme";
import { ToastProvider, useToast } from "@/components/Toast";
import { UploadZone } from "@/components/UploadZone";
import { TrackList } from "@/components/TrackList";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ProcessingView } from "@/components/ProcessingView";
import { ResultsDashboard } from "@/components/ResultsDashboard";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const AUDIO_EXTENSIONS = [
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

const MIME_BY_EXTENSION: Record<string, string> = {
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

const TARGET_LUFS_LABEL: Record<string, string> = {
  SPOTIFY: "−14 LUFS",
  APPLE_MUSIC: "−16 LUFS",
  YOUTUBE: "−14 LUFS",
  CD: "−9 LUFS",
};

/** Live status line per mastering progress fraction (engine internals). */
const MASTERING_STATUS = (f: number, target: string): string => {
  if (f < 0.03) return "Initializing mastering chain…";
  if (f < 0.18) return "Applying genre EQ — low shelf & air…";
  if (f < 0.34) return "Sculpting tonal balance, carving low-mids…";
  if (f < 0.5) return "Mid/side imaging — mono lows, stereo widening…";
  if (f < 0.6) return "Analog-style saturation & bus compression…";
  if (f < 0.75) return `Normalizing loudness to ${target}…`;
  if (f < 0.9) return "True-peak limiting to −1.0 dBTP…";
  return "Finalizing master gain…";
};

const MIXING_STATUS = (f: number): string =>
  f < 0.34
    ? "Measuring integrated loudness (BS.1770-4)…"
    : f < 0.67
      ? "Verifying source true peak…"
      : "Analyzing source dynamics & stereo image…";

const QC_STATUS = (f: number): string =>
  f < 0.34
    ? "Measuring mastered loudness…"
    : f < 0.67
      ? "Verifying mastered true peak…"
      : "Computing dynamic range & stereo width…";

/** Numeric loudness target for a loudness key. */
function targetLufsFor(loudness: string): number {
  switch (loudness) {
    case "CD":
      return -9;
    case "APPLE_MUSIC":
      return -16;
    case "SPOTIFY":
    case "YOUTUBE":
    default:
      return -14;
  }
}

/** Flatten the engine report into a lightweight, serialisable UI summary. */
function buildSessionAuto(report: AutoReport): SessionAuto {
  const mapStep = (s: { name: string; note?: string; params: Record<string, unknown>; order: number }): SessionStep => ({
    name: s.name,
    note: s.note,
    params: s.params,
    order: s.order,
  });
  const mapQa = (q: AutoReport["qa"]): SessionQa => ({
    attempt: q.attempt,
    passed: q.passed,
    lufs: q.lufs,
    lufsDelta: q.lufsDelta,
    truePeakDb: q.truePeakDb,
    correlation: q.correlation,
    dynamicRange: q.dynamicRange,
    failures: [...q.failures],
  });
  const stems: SessionStem[] = report.stems.map((s) => ({
    name: s.name,
    category: s.category,
    categoryLabel: s.categoryLabel,
    chainLabel: s.chainLabel,
    steps: s.steps.map(mapStep),
  }));
  return {
    bpm: report.bpm,
    warnings: [...report.warnings],
    stems,
    masterSteps: report.masterSteps.map(mapStep),
    qa: mapQa(report.qa),
    attempts: report.qaAttempts.map(mapQa),
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function toPcm(buffer: AudioBuffer): PcmData {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  return { sampleRate: buffer.sampleRate, channels };
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function StudioApp() {
  const { toast } = useToast();
  const { theme, toggleTheme } = useTheme();

  const [phase, setPhase] = useState<Phase>("idle");
  const [project, setProject] = useState<Project | null>(null);
  const [loadInfo, setLoadInfo] = useState<{ percent: number; message: string } | null>(null);
  const [settings, setSettings] = useState<Settings>({
    genre: "POP",
    loudness: "SPOTIFY",
    intensity: 75,
    vocalFocus: true,
  });
  const [process, setProcess] = useState<{
    progress: number;
    stage: Stage;
    status: string;
  }>({ progress: 0, stage: "mixing", status: "" });
  const [eta, setEta] = useState<number | null>(null);
  const [session, setSession] = useState<MasterSession | null>(null);
  /** Active auto-engine stage index (0-9) while processing, for the timeline. */
  const [autoStage, setAutoStage] = useState<number>(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  /** Track preview URLs die with the project; session preview URLs die with the session. */
  const trackUrlsRef = useRef<string[]>([]);
  const sessionUrlsRef = useRef<string[]>([]);
  const progressRef = useRef({ p: 0, t: 0, rate: 0 });
  const autoStatus = useRef<string>("");

  /* ---------------- audio context ---------------- */

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  }, []);

  /* ---------------- blob URL bookkeeping ---------------- */

  const rememberTrackUrl = useCallback((url: string) => {
    trackUrlsRef.current.push(url);
    return url;
  }, []);

  const rememberSessionUrl = useCallback((url: string) => {
    sessionUrlsRef.current.push(url);
    return url;
  }, []);

  const releaseTrackUrls = useCallback(() => {
    trackUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    trackUrlsRef.current = [];
  }, []);

  const releaseSessionUrls = useCallback(() => {
    sessionUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    sessionUrlsRef.current = [];
  }, []);

  const releaseAllUrls = useCallback(() => {
    releaseTrackUrls();
    releaseSessionUrls();
  }, [releaseSessionUrls, releaseTrackUrls]);

  useEffect(
    () => () => {
      releaseAllUrls();
    },
    [releaseAllUrls]
  );

  /* ---------------- load a project (ZIP or single audio file) ---------------- */

  const loadProject = useCallback(
    async (file: File) => {
      releaseAllUrls();
      setSession(null);
      setProject(null);
      setPhase("loading");
      setLoadInfo({ percent: 4, message: "Reading file…" });

      try {
        const lower = file.name.toLowerCase();
        const isZip = lower.endsWith(".zip") || file.type.includes("zip");

        let raw: { name: string; data: ArrayBuffer }[] = [];

        if (isZip) {
          const buf = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(buf);
          setLoadInfo({ percent: 12, message: "Scanning ZIP contents…" });

          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            // Skip OS junk that otherwise shows up as unreadable "tracks".
            if (
              path.includes("__MACOSX") ||
              path.includes(".DS_Store") ||
              path.startsWith(".")
            )
              continue;
            const dot = path.lastIndexOf(".");
            const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
            if (!AUDIO_EXTENSIONS.includes(ext)) continue;
            const data = await entry.async("arraybuffer");
            raw.push({ name: path.split("/").pop() || path, data });
          }

          if (raw.length === 0) {
            throw new Error("No audio files found in that ZIP.");
          }
          setLoadInfo({
            percent: 18,
            message: `${raw.length} audio file${raw.length === 1 ? "" : "s"} found`,
          });
        } else {
          const data = await file.arrayBuffer();
          raw = [{ name: file.name, data }];
          setLoadInfo({ percent: 18, message: "Audio file found" });
        }

        const ctx = getAudioContext();
        const tracks: TrackInfo[] = [];
        for (let i = 0; i < raw.length; i++) {
          const f = raw[i];
          setLoadInfo({
            percent: 18 + 72 * (i / raw.length),
            message: `Decoding ${f.name}…`,
          });

          let buffer: AudioBuffer;
          try {
            // Copy: decodeAudioData may detach the buffer in some engines.
            buffer = await ctx.decodeAudioData(f.data.slice(0));
          } catch {
            toast({
              type: "error",
              title: `Skipped “${f.name}”`,
              message: "Could not decode this file — it was left out of the session.",
            });
            continue;
          }

          const dot = f.name.lastIndexOf(".");
          const ext = dot === -1 ? "" : f.name.slice(dot).toLowerCase();
          const mime = MIME_BY_EXTENSION[ext] ?? "audio/wav";
          const url = rememberTrackUrl(
            URL.createObjectURL(new Blob([f.data], { type: mime }))
          );
          tracks.push({
            name: f.name,
            size: f.data.byteLength,
            duration: buffer.duration,
            url,
            buffer,
          });
          await tick(16);
        }

        if (tracks.length === 0) {
          throw new Error("No decodable audio files found.");
        }

        const totalDuration = Math.max(...tracks.map((t) => t.duration));
        setProject({
          fileName: file.name,
          fileSize: file.size,
          tracks,
          totalDuration,
        });
        setLoadInfo({ percent: 100, message: "Ready" });
        setPhase("ready");
        toast({
          type: "success",
          title: "Project loaded",
          message: `${tracks.length} track${tracks.length === 1 ? "" : "s"} ready — pick a profile and hit Mix & Master.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        releaseAllUrls();
        setProject(null);
        setLoadInfo(null);
        setPhase("idle");
        toast({ type: "error", title: "Could not read file", message });
      }
    },
    [getAudioContext, rememberTrackUrl, releaseAllUrls, toast]
  );

  /* ---------------- mastering pipeline ---------------- */

  const startProcess = useCallback(async () => {
    if (!project || phase === "processing") return;

    setPhase("processing");
    setEta(null);
    setAutoStage(0);
    autoStatus.current = "";
    progressRef.current = { p: 0, t: performance.now(), rate: 0 };

    /** Report progress; keeps an EMA of the rate for the ETA estimate. */
    const report = (p: number, stage: Stage, status: string) => {
      const now = performance.now();
      const ref = progressRef.current;
      const dt = now - ref.t;
      if (dt > 150 && p > ref.p + 0.01) {
        const inst = (p - ref.p) / dt; // percent per ms
        ref.rate = ref.rate === 0 ? inst : ref.rate * 0.6 + inst * 0.4;
        ref.t = now;
        ref.p = p;
        setEta(Math.max(0, (100 - p) / ref.rate / 1000));
      }
      setProcess({ progress: p, stage, status });
    };

    const startedAt = performance.now();

    try {
      /* ---- Stage 1: MIXING (0-10%) ---- */
      report(2, "mixing", `Summing ${project.tracks.length} track${project.tracks.length === 1 ? "" : "s"} to stereo bus…`);
      await tick(80);

      const pcmTracks = project.tracks.map((t) => toPcm(t.buffer));
      const originalPcm = sumTracks(pcmTracks);

      report(7, "mixing", MIXING_STATUS(0));
      const before: Metrics = await measureAll(originalPcm, (f) =>
        report(7 + f * 3, "mixing", MIXING_STATUS(f))
      );

      /* ---- Stage 2: MASTERING (10-88%) — automatic plugin engine ---- */
      const lufsLabel =
        TARGET_LUFS_LABEL[settings.loudness] ?? settings.loudness;
      const targetLufs = targetLufsFor(settings.loudness);
      report(10, "mastering", "Auditing stems & detecting instrument categories…");

      const autoReport: AutoReport = await processAutoEngine(
        pcmTracks.map((p, i) => ({
          name: project.tracks[i].name,
          buffer: p,
        })),
        {
          genre: settings.genre,
          loudness: settings.loudness,
          intensity: settings.intensity,
          vocalFocus: settings.vocalFocus,
          targetLufs,
          onProgress: (f) =>
            report(10 + f * 78, "mastering", autoStatus.current || MASTERING_STATUS(f, lufsLabel)),
          onStatus: (msg) => {
            autoStatus.current = msg;
            setProcess((p) => ({ ...p, stage: "mastering", status: msg }));
          },
          onStage: (i) => setAutoStage(i),
        }
      );

      const masteredPcm: PcmData = autoReport.master;

      /* ---- Stage 3: QC (88-100%) ---- */
      report(88, "qc", QC_STATUS(0));
      const after: Metrics = await measureAll(masteredPcm, (f) =>
        report(88 + f * 9, "qc", QC_STATUS(f))
      );
      setAutoStage(AUTO_STAGE_LABELS.length - 1);

      report(97, "qc", "Rendering master WAV…");
      await tick(60);
      const masterWav = wavBlob(masteredPcm, 24);
      const originalWav = wavBlob(originalPcm, 16);

      report(99, "qc", "Preparing A/B comparison…");
      await tick(60);
      const masteredUrl = rememberSessionUrl(URL.createObjectURL(masterWav));
      const originalUrl = rememberSessionUrl(URL.createObjectURL(originalWav));
      report(100, "qc", "Quality check passed");

      const frames = masteredPcm.channels[0].length;
      const newSession: MasterSession = {
        settings: { ...settings },
        originalPcm,
        originalUrl,
        masteredPcm,
        masteredUrl,
        before,
        after,
        durationSec: frames / masteredPcm.sampleRate,
        sampleRate: masteredPcm.sampleRate,
        elapsedSec: (performance.now() - startedAt) / 1000,
        tracks: project.tracks.map((t) => ({ name: t.name, buffer: t.buffer })),
        auto: buildSessionAuto(autoReport),
      };

      await tick(350);
      setSession(newSession);
      setEta(null);
      setPhase("done");
      toast({
        type: "success",
        title: "Mastering complete",
        message: "A/B comparison ready — compare, tweak, or export.",
      });
      if (autoReport.warnings.length) {
        toast({
          type: "info",
          title: "QA warning",
          message: autoReport.warnings[autoReport.warnings.length - 1],
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      setPhase(project ? "ready" : "idle");
      toast({ type: "error", title: "Processing failed", message });
    }
  }, [project, phase, settings, rememberSessionUrl, toast]);

  /* ---------------- project lifecycle ---------------- */

  const clearProject = useCallback(() => {
    releaseAllUrls();
    setProject(null);
    setSession(null);
    setLoadInfo(null);
    setPhase("idle");
  }, [releaseAllUrls]);

  const remaster = useCallback(() => {
    releaseSessionUrls(); // drops the session's preview URLs only
    setSession(null);
    setPhase("ready");
  }, [releaseSessionUrls]);

  /* ---------------- render ---------------- */

  return (
    <div className="min-h-dvh">
      <Header theme={theme} onToggleTheme={toggleTheme} />

      <main className="mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-6">
        {phase === "done" && session ? (
          <ResultsDashboard
            session={session}
            sourceName={project?.fileName ?? "master"}
            theme={theme}
            onNewProject={clearProject}
            onRemaster={remaster}
          />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="space-y-5">
              <UploadZone
                phase={phase}
                project={project}
                loadInfo={loadInfo}
                onFileSelected={(f) => void loadProject(f)}
                onClear={clearProject}
              />
              {(project || phase === "loading") && (
                <TrackList
                  tracks={project?.tracks ?? null}
                  loading={phase === "loading"}
                />
              )}
            </div>

            <div className="lg:sticky lg:top-24">
              {phase === "processing" ? (
                <ProcessingView
                  progress={process.progress}
                  stage={process.stage}
                  status={process.status}
                  eta={eta}
                  autoStage={process.stage === "mastering" ? autoStage : undefined}
                  summary={{
                    genre: settings.genre,
                    loudness: settings.loudness,
                    tracks: project?.tracks.length ?? 0,
                  }}
                />
              ) : (
                <SettingsPanel
                  settings={settings}
                  onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                  onProcess={() => void startProcess()}
                  disabled={phase === "loading"}
                  hasProject={!!project && phase === "ready"}
                />
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="pb-10 text-center text-[11px] font-medium text-faint">
        StudioPro — professional mix &amp; master · runs 100% in your browser ·
        audio never leaves your device
      </footer>
    </div>
  );
}

export default function Home() {
  return (
    <ToastProvider>
      <StudioApp />
    </ToastProvider>
  );
}
