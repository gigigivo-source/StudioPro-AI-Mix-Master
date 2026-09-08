"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { masterStereoPcm, sumTracks, type PcmData } from "@/lib/client-audio-engine";
import { measureAll, type Metrics } from "@/lib/analysis";
import { wavBlob } from "@/lib/exports";
import {
  extractAudioEntries,
  getExtension,
  MIME_BY_EXTENSION,
  readFileWithProgress,
  validateFile,
} from "@/lib/file-loader";
import type {
  BatchItem,
  MasterSession,
  Phase,
  Project,
  Settings,
  Stage,
  TrackInfo,
  UploadProgress,
} from "@/lib/types";
import { Header } from "@/components/Header";
import { useTheme } from "@/hooks/useTheme";
import { ToastProvider, useToast } from "@/components/Toast";
import { UploadZone } from "@/components/UploadZone";
import { TrackList } from "@/components/TrackList";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ProcessingView } from "@/components/ProcessingView";
import { ResultsDashboard } from "@/components/ResultsDashboard";
import { BatchQueueView } from "@/components/BatchQueueView";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SETTINGS_STORAGE_KEY = "studiopro-settings";

const DEFAULT_SETTINGS: Settings = {
  genre: "POP",
  loudness: "SPOTIFY",
  intensity: 75,
  vocalFocus: true,
  volume: 85,
};

function readSavedSettings(): { settings: Settings; wasRestored: boolean } {
  if (typeof window === "undefined") {
    return { settings: DEFAULT_SETTINGS, wasRestored: false };
  }
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") {
        return {
          settings: { ...DEFAULT_SETTINGS, ...parsed },
          wasRestored: true,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { settings: DEFAULT_SETTINGS, wasRestored: false };
}

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

function clonePcm(pcm: PcmData): PcmData {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((c) => new Float32Array(c)),
  };
}

/* ------------------------------------------------------------------ */
/* App Component                                                       */
/* ------------------------------------------------------------------ */

function StudioApp() {
  const { toast } = useToast();
  const { theme, toggleTheme, accent, setAccent } = useTheme();

  const [phase, setPhase] = useState<Phase>("idle");
  const [project, setProject] = useState<Project | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const [settings, setSettings] = useState<Settings>(() => readSavedSettings().settings);

  const [process, setProcess] = useState<{
    progress: number;
    stage: Stage;
    status: string;
  }>({ progress: 0, stage: "mixing", status: "" });

  const [eta, setEta] = useState<number | null>(null);
  const [session, setSession] = useState<MasterSession | null>(null);

  // Batch processing state
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchIndex, setBatchIndex] = useState<number>(0);
  const [isBatchProcessing, setIsBatchProcessing] = useState<boolean>(false);

  // Abort Controllers
  const uploadAbortRef = useRef<AbortController | null>(null);
  const processAbortRef = useRef<AbortController | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const trackUrlsRef = useRef<string[]>([]);
  const sessionUrlsRef = useRef<string[]>([]);
  const progressRef = useRef({ p: 0, t: 0, rate: 0 });

  /* ---------------- Session Persistence (Initial Toast) ---------------- */

  useEffect(() => {
    const { wasRestored } = readSavedSettings();
    if (wasRestored) {
      toast({
        type: "info",
        title: "Settings restored",
        message: "Loaded your previous mastering preferences.",
      });
    }
  }, [toast]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  /* ---------------- Audio Context ---------------- */

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  }, []);

  /* ---------------- Blob URL Bookkeeping ---------------- */

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

  useEffect(() => () => releaseAllUrls(), [releaseAllUrls]);

  /* ---------------- Cancel Actions ---------------- */

  const cancelUpload = useCallback(() => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
    }
    releaseAllUrls();
    setProject(null);
    setUploadProgress(null);
    setPhase("idle");
    toast({
      type: "info",
      title: "Upload cancelled",
      message: "File upload was cancelled.",
    });
  }, [releaseAllUrls, toast]);

  const cancelProcessing = useCallback(() => {
    if (processAbortRef.current) {
      processAbortRef.current.abort();
      processAbortRef.current = null;
    }
    setEta(null);
    setProcess({ progress: 0, stage: "mixing", status: "" });
    setPhase(project ? "ready" : "idle");
    toast({
      type: "info",
      title: "Processing cancelled",
      message: "Mastering pipeline was cancelled.",
    });
  }, [project, toast]);

  /* Keyboard shortcut for Escape to cancel */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "loading") {
          cancelUpload();
        } else if (phase === "processing") {
          cancelProcessing();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, cancelUpload, cancelProcessing]);

  /* ---------------- Load Project (Single File or ZIP) ---------------- */

  const loadProject = useCallback(
    async (file: File) => {
      // 1. Validation
      const validation = validateFile(file);
      if (!validation.valid) {
        toast({
          type: "error",
          title: "Invalid file",
          message: validation.error || "Please select a supported audio or ZIP file.",
        });
        return;
      }

      releaseAllUrls();
      setSession(null);
      setProject(null);
      setPhase("loading");

      const abortController = new AbortController();
      uploadAbortRef.current = abortController;
      const signal = abortController.signal;

      setUploadProgress({
        loaded: 0,
        total: file.size,
        percent: 0,
        speedMBs: 0,
        etaSec: null,
        stage: "reading",
        message: "Starting upload & reading file…",
      });

      try {
        // 2. Read with real streaming progress
        const arrayBuffer = await readFileWithProgress(file, {
          onProgress: (p) => setUploadProgress(p),
          signal,
        });

        if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");

        // 3. Extract audio files
        setUploadProgress((prev) => ({
          loaded: file.size,
          total: file.size,
          percent: 100,
          speedMBs: prev?.speedMBs || 0,
          etaSec: null,
          stage: "extracting",
          message: validation.isZip ? "Unpacking ZIP stems…" : "Reading audio data…",
        }));

        const rawEntries = await extractAudioEntries(arrayBuffer, file.name, {
          onProgress: (p) => setUploadProgress(p),
          signal,
        });

        if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");

        // 4. Decode audio tracks
        const ctx = getAudioContext();
        const tracks: TrackInfo[] = [];

        for (let i = 0; i < rawEntries.length; i++) {
          if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");

          const entry = rawEntries[i];
          setUploadProgress({
            loaded: file.size,
            total: file.size,
            percent: Math.round(((i + 1) / rawEntries.length) * 100),
            speedMBs: 0,
            etaSec: null,
            stage: "decoding",
            message: `Decoding track ${i + 1} of ${rawEntries.length} (${entry.name})…`,
          });

          let buffer: AudioBuffer;
          try {
            buffer = await ctx.decodeAudioData(entry.data.slice(0));
          } catch {
            toast({
              type: "error",
              title: `Could not decode “${entry.name}”`,
              message: "This track could not be decoded and was omitted.",
            });
            continue;
          }

          const ext = getExtension(entry.name);
          const mime = MIME_BY_EXTENSION[ext] ?? "audio/wav";
          const url = rememberTrackUrl(
            URL.createObjectURL(new Blob([entry.data], { type: mime }))
          );

          tracks.push({
            name: entry.name,
            size: entry.data.byteLength,
            duration: buffer.duration,
            url,
            buffer,
          });

          await tick(16);
        }

        if (tracks.length === 0) {
          throw new Error("No decodable audio tracks found in this file.");
        }

        const totalDuration = Math.max(...tracks.map((t) => t.duration));
        setProject({
          fileName: file.name,
          fileSize: file.size,
          tracks,
          totalDuration,
        });

        setUploadProgress(null);
        setPhase("ready");

        toast({
          type: "success",
          title: "Session loaded",
          message: `${tracks.length} ${tracks.length === 1 ? "track" : "stems"} ready. Select mastering profile and start.`,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return; // Handled by cancelUpload
        }
        const message = err instanceof Error ? err.message : String(err);
        releaseAllUrls();
        setProject(null);
        setUploadProgress(null);
        setPhase("idle");
        toast({ type: "error", title: "Could not read audio session", message });
      } finally {
        uploadAbortRef.current = null;
      }
    },
    [getAudioContext, rememberTrackUrl, releaseAllUrls, toast]
  );

  /* ---------------- Multi-file / Batch Support ---------------- */

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      if (files.length === 1) {
        void loadProject(files[0]);
        return;
      }

      const validItems: BatchItem[] = [];
      for (const file of files) {
        const v = validateFile(file);
        if (v.valid) {
          validItems.push({
            id: Math.random().toString(36).substring(2, 9),
            file,
            name: file.name,
            size: file.size,
            status: "queued",
            progress: 0,
          });
        }
      }

      if (validItems.length === 0) {
        toast({
          type: "error",
          title: "No valid audio files",
          message: "None of the selected files were supported audio formats.",
        });
        return;
      }

      setBatchItems(validItems);
      setBatchIndex(0);
      setPhase("batch");
      toast({
        type: "info",
        title: "Batch queue created",
        message: `${validItems.length} tracks added to album mastering queue.`,
      });
    },
    [loadProject, toast]
  );

  const startBatchProcess = useCallback(async () => {
    if (batchItems.length === 0 || isBatchProcessing) return;

    setIsBatchProcessing(true);
    const abort = new AbortController();
    batchAbortRef.current = abort;
    const signal = abort.signal;

    for (let i = 0; i < batchItems.length; i++) {
      if (signal.aborted) break;

      const item = batchItems[i];
      if (item.status === "done") continue;

      setBatchIndex(i);
      setBatchItems((prev) =>
        prev.map((it, idx) => (idx === i ? { ...it, status: "processing", progress: 5 } : it))
      );

      try {
        const arrayBuf = await readFileWithProgress(item.file, {
          onProgress: (p) => {
            setBatchItems((prev) =>
              prev.map((it, idx) =>
                idx === i ? { ...it, progress: Math.min(25, p.percent * 0.25) } : it
              )
            );
          },
          signal,
        });

        const ctx = getAudioContext();
        const buffer = await ctx.decodeAudioData(arrayBuf.slice(0));

        setBatchItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, progress: 30, duration: buffer.duration } : it
          )
        );

        const pcm = toPcm(buffer);
        const originalPcm = clonePcm(pcm);

        const before = await measureAll(
          originalPcm,
          (f) => {
            setBatchItems((prev) =>
              prev.map((it, idx) =>
                idx === i ? { ...it, progress: 30 + f * 15 } : it
              )
            );
          },
          signal
        );

        const work = clonePcm(originalPcm);
        const masteredPcm = await masterStereoPcm(work, {
          genre: settings.genre,
          loudness: settings.loudness,
          intensity: settings.intensity,
          vocalFocus: settings.vocalFocus,
          signal,
          onProgress: (f) => {
            setBatchItems((prev) =>
              prev.map((it, idx) =>
                idx === i ? { ...it, progress: 45 + f * 45 } : it
              )
            );
          },
        });

        const after = await measureAll(masteredPcm, undefined, signal);
        const masterBlob = wavBlob(masteredPcm, 24);
        const originalBlob = wavBlob(originalPcm, 16);

        const masteredUrl = rememberSessionUrl(URL.createObjectURL(masterBlob));
        const originalUrl = rememberSessionUrl(URL.createObjectURL(originalBlob));

        const itemSession: MasterSession = {
          settings: { ...settings },
          originalPcm,
          originalUrl,
          masteredPcm,
          masteredUrl,
          before,
          after,
          durationSec: buffer.duration,
          sampleRate: buffer.sampleRate,
          elapsedSec: 0,
          tracks: [{ name: item.name, buffer }],
        };

        setBatchItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? {
                  ...it,
                  status: "done",
                  progress: 100,
                  session: itemSession,
                  masteredBlob: masterBlob,
                }
              : it
          )
        );
      } catch (err) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        setBatchItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "error", error: msg, progress: 0 } : it
          )
        );
      }
    }

    setIsBatchProcessing(false);
    batchAbortRef.current = null;
    toast({
      type: "success",
      title: "Batch mastering finished",
      message: "All queue items have completed.",
    });
  }, [
    batchItems,
    isBatchProcessing,
    getAudioContext,
    settings,
    rememberSessionUrl,
    toast,
  ]);

  const cancelBatchProcess = useCallback(() => {
    if (batchAbortRef.current) {
      batchAbortRef.current.abort();
      batchAbortRef.current = null;
    }
    setIsBatchProcessing(false);
    toast({
      type: "info",
      title: "Batch cancelled",
      message: "Batch queue processing stopped.",
    });
  }, [toast]);

  /* ---------------- Mastering Pipeline ---------------- */

  const startProcess = useCallback(async () => {
    if (!project || phase === "processing") return;

    setPhase("processing");
    setEta(null);
    progressRef.current = { p: 0, t: performance.now(), rate: 0 };

    const abortController = new AbortController();
    processAbortRef.current = abortController;
    const signal = abortController.signal;

    /** Report progress; keeps an EMA of the rate for the ETA estimate. */
    const report = (p: number, stage: Stage, status: string) => {
      const now = performance.now();
      const ref = progressRef.current;
      const dt = now - ref.t;
      if (dt > 120 && p > ref.p + 0.01) {
        const inst = (p - ref.p) / dt; // percent per ms
        ref.rate = ref.rate === 0 ? inst : ref.rate * 0.65 + inst * 0.35;
        ref.t = now;
        ref.p = p;
        if (ref.rate > 0) {
          const remainingSec = (100 - p) / ref.rate / 1000;
          setEta(Math.max(0, remainingSec));
        }
      }
      setProcess({ progress: p, stage, status });
    };

    const startedAt = performance.now();

    try {
      /* ---- Stage 1: MIXING (0-10%) ---- */
      report(
        2,
        "mixing",
        `Summing ${project.tracks.length} track${project.tracks.length === 1 ? "" : "s"} to stereo bus…`
      );
      await tick(60);

      const pcmTracks = project.tracks.map((t) => toPcm(t.buffer));
      const originalPcm = sumTracks(pcmTracks);

      report(7, "mixing", MIXING_STATUS(0));
      const before: Metrics = await measureAll(
        originalPcm,
        (f) => report(7 + f * 3, "mixing", MIXING_STATUS(f)),
        signal
      );

      /* ---- Stage 2: MASTERING (10-88%) ---- */
      const lufsLabel = TARGET_LUFS_LABEL[settings.loudness] ?? settings.loudness;
      report(10, "mastering", "Initializing mastering chain…");

      const work = clonePcm(originalPcm);
      const masteredPcm = await masterStereoPcm(work, {
        genre: settings.genre,
        loudness: settings.loudness,
        intensity: settings.intensity,
        vocalFocus: settings.vocalFocus,
        signal,
        onProgress: (f) =>
          report(10 + f * 78, "mastering", MASTERING_STATUS(f, lufsLabel)),
      });

      /* ---- Stage 3: QC (88-100%) ---- */
      report(88, "qc", QC_STATUS(0));
      const after: Metrics = await measureAll(
        masteredPcm,
        (f) => report(88 + f * 9, "qc", QC_STATUS(f)),
        signal
      );

      report(97, "qc", "Rendering master WAV…");
      await tick(40);
      const masterWav = wavBlob(masteredPcm, 24);
      const originalWav = wavBlob(originalPcm, 16);

      report(99, "qc", "Preparing A/B comparison…");
      await tick(40);
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
      };

      await tick(300);
      setSession(newSession);
      setEta(null);
      setPhase("done");

      toast({
        type: "success",
        title: "Mastering complete",
        message: "A/B comparison ready — compare, tweak, or export.",
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return; // Handled by cancelProcessing
      }
      const message = err instanceof Error ? err.message : String(err);
      setPhase(project ? "ready" : "idle");
      toast({ type: "error", title: "Mastering pipeline failed", message });
    } finally {
      processAbortRef.current = null;
    }
  }, [project, phase, settings, rememberSessionUrl, toast]);

  /* ---------------- Project Lifecycle ---------------- */

  const clearProject = useCallback(() => {
    releaseAllUrls();
    setProject(null);
    setSession(null);
    setUploadProgress(null);
    setBatchItems([]);
    setPhase("idle");
  }, [releaseAllUrls]);

  const remaster = useCallback(() => {
    releaseSessionUrls();
    setSession(null);
    setPhase("ready");
  }, [releaseSessionUrls]);

  /* ---------------- Render ---------------- */

  return (
    <div className="min-h-dvh">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        accent={accent}
        onSelectAccent={setAccent}
      />

      <main className="mx-auto max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
        {phase === "batch" ? (
          <BatchQueueView
            items={batchItems}
            isProcessing={isBatchProcessing}
            currentIndex={batchIndex}
            settings={settings}
            theme={theme}
            onStartBatch={() => void startBatchProcess()}
            onCancelBatch={cancelBatchProcess}
            onRemoveItem={(id) => setBatchItems((prev) => prev.filter((it) => it.id !== id))}
            onClearQueue={() => setBatchItems([])}
            onNewProject={clearProject}
          />
        ) : phase === "done" && session ? (
          <ResultsDashboard
            session={session}
            sourceName={project?.fileName ?? "master"}
            theme={theme}
            initialVolume={settings.volume ?? 85}
            onVolumeChange={(vol) => updateSettings({ volume: vol })}
            onNewProject={clearProject}
            onRemaster={remaster}
          />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_390px] xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="space-y-5">
              <UploadZone
                phase={phase}
                project={project}
                uploadProgress={uploadProgress}
                onFileSelected={(f) => void loadProject(f)}
                onFilesSelected={handleFilesSelected}
                onCancel={cancelUpload}
                onClear={clearProject}
                onError={(msg) => toast({ type: "error", title: "Upload error", message: msg })}
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
                  summary={{
                    genre: settings.genre,
                    loudness: settings.loudness,
                    tracks: project?.tracks.length ?? 0,
                  }}
                  onCancel={cancelProcessing}
                />
              ) : (
                <SettingsPanel
                  settings={settings}
                  onChange={updateSettings}
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
        StudioPro — professional mix &amp; master · runs 100% in your browser · audio never leaves your device
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
