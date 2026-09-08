"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import JSZip from "jszip";
import { clonePcm, masterStereoPcm, sumTracks, type PcmData } from "@/lib/client-audio-engine";
import {
  buildPreviewWav,
  decodeNonWavBytes,
  decodeNonWavFile,
  decodeWavBytes,
  estimateProjectPeakBytes,
  memoryVerdict,
  MEMORY_REJECT_MESSAGE,
  MEMORY_WARNING_MESSAGE,
  parseWavStreaming,
  readWavHeader,
} from "@/lib/file-loader";
import { measureAll, type Metrics } from "@/lib/analysis";
import type {
  MasterSession,
  Phase,
  Project,
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

const WAV_EXTENSIONS = [".wav"];

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

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

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
  /** Large-file warning shown as a confirm dialog before processing. */
  const [memoryWarning, setMemoryWarning] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const progressRef = useRef({ p: 0, t: 0, rate: 0 });
  /**
   * Track preview URLs are generated lazily (compact 22.05 kHz / 16-bit
   * previews) and revoked as soon as they are no longer needed.
   */
  const previewUrlsRef = useRef<Map<number, string>>(new Map());

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

  /* ---------------- preview URL bookkeeping ---------------- */

  const releasePreviewUrls = useCallback(() => {
    previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    previewUrlsRef.current.clear();
  }, []);

  useEffect(
    () => () => {
      releasePreviewUrls();
    },
    [releasePreviewUrls]
  );

  /**
   * Lazily build (and cache) a compact playback preview for a track.
   * Nothing is created at upload time — only when the user actually plays.
   */
  const getPreviewUrl = useCallback(
    async (index: number): Promise<string> => {
      const cached = previewUrlsRef.current.get(index);
      if (cached) return cached;
      const track = project?.tracks[index];
      if (!track) throw new Error("Track no longer available");
      const blob = await buildPreviewWav(track.pcm);
      const url = URL.createObjectURL(blob);
      previewUrlsRef.current.set(index, url);
      return url;
    },
    [project]
  );

  /* ---------------- load a project (ZIP or single audio file) ---------------- */

  const loadProject = useCallback(
    async (file: File) => {
      releasePreviewUrls();
      setSession(null);
      setProject(null);
      setPhase("loading");
      setLoadInfo({ percent: 4, message: "Reading file…" });

      try {
        const lower = file.name.toLowerCase();
        const isZip = lower.endsWith(".zip") || file.type.includes("zip");
        const isWav = !isZip && WAV_EXTENSIONS.includes(extOf(lower));

        const ctx = getAudioContext();
        const tracks: TrackInfo[] = [];

        /** Exact memory gate, re-evaluated after every decoded track. */
        const memoryGuard = () =>
          memoryVerdict(estimateProjectPeakBytes(tracks.map((t) => t.pcm))).level ===
          "reject";

        if (isZip) {
          // JSZip needs the whole archive to parse the central directory —
          // this is the one unavoidable full-file read (ZIPs, not WAVs).
          // The buffer is dropped right after the archive is parsed.
          let zipBuf: ArrayBuffer | null = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(zipBuf);
          zipBuf = null;
          setLoadInfo({ percent: 12, message: "Scanning ZIP contents…" });

          const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            // Skip OS junk that otherwise shows up as unreadable "tracks".
            if (
              path.includes("__MACOSX") ||
              path.includes(".DS_Store") ||
              path.startsWith(".")
            )
              continue;
            const ext = extOf(path);
            if (!AUDIO_EXTENSIONS.includes(ext)) continue;
            entries.push({ path, entry });
          }

          if (entries.length === 0) {
            throw new Error("No audio files found in that ZIP.");
          }

          // Rough early gate from uncompressed entry sizes so a 32-stem
          // bundle is rejected before a single stem is decoded. WAV float
          // PCM is ≤ 2× raw; compressed sources can expand up to ~4×.
          let estPcm = 0;
          for (const { entry } of entries) {
            const size =
              (entry as unknown as { _data?: { uncompressedSize?: number } })._data
                ?.uncompressedSize ?? 0;
            estPcm += size > 0 ? size * (extOf(entry.name) === ".wav" ? 2 : 4) : 0;
          }
          const estPeak = estPcm + 2 * (estPcm / Math.max(1, entries.length)) + 64 * 1024 * 1024;
          if (memoryVerdict(estPeak).level === "reject") {
            throw new Error(MEMORY_REJECT_MESSAGE);
          }

          // Extract + decode ONE entry at a time; its raw bytes are dropped
          // before the next entry is touched.
          for (let i = 0; i < entries.length; i++) {
            const { path, entry } = entries[i];
            const name = path.split("/").pop() || path;
            setLoadInfo({
              percent: 12 + 80 * (i / entries.length),
              message: `Extracting ${name} (${i + 1}/${entries.length})…`,
            });

            const data = await entry.async("arraybuffer");
            try {
              if (WAV_EXTENSIONS.includes(extOf(name))) {
                // Streaming-capable parser on the extracted bytes — converted
                // in 32 MiB chunks with yields, then the bytes are released.
                const { pcm, header } = await decodeWavBytes(data);
                tracks.push({ name, size: data.byteLength, duration: header.durationSec, pcm });
              } else {
                const { pcm, durationSec } = await decodeNonWavBytes(data, ctx);
                tracks.push({ name, size: data.byteLength, duration: durationSec, pcm });
              }
            } catch {
              toast({
                type: "error",
                title: `Skipped “${name}”`,
                message: "Could not decode this file — it was left out of the session.",
              });
              continue;
            }
            // The entry's raw bytes are now released before the next
            // extraction; only the decoded PCM (the one copy we keep) lives
            // in `tracks`.
            if (memoryGuard()) {
              releasePreviewUrls();
              tracks.length = 0;
              throw new Error(MEMORY_REJECT_MESSAGE);
            }
            await tick(16);
          }
        } else if (isWav) {
          // WAV: never read the whole file. Header first (a few hundred KB),
          // then stream the data chunk in 32 MiB slices straight into the
          // float32 channel arrays.
          setLoadInfo({ percent: 8, message: "Reading WAV header…" });
          const header = await readWavHeader(file);

          // Single track: the summed bus shares the track arrays (zero-copy
          // sum), so peak ≈ 2× decoded PCM + headroom.
          const peak = header.pcmBytes * 2 + 64 * 1024 * 1024;
          const verdict = memoryVerdict(peak);
          if (verdict.level === "reject") {
            throw new Error(MEMORY_REJECT_MESSAGE);
          }
          // "warn" is re-checked (and confirmed by the user) at process time.

          setLoadInfo({ percent: 8, message: "Streaming WAV data…" });
          const { pcm } = await parseWavStreaming(file, {
            onProgress: (f) =>
              setLoadInfo({ percent: 8 + f * 84, message: "Streaming WAV data…" }),
          });
          tracks.push({ name: file.name, size: file.size, duration: header.durationSec, pcm });
        } else {
          // Non-WAV single file (MP3/FLAC/…): Web Audio decoding needs the
          // bytes; they are held only for the decode call (see file-loader).
          setLoadInfo({ percent: 8, message: "Decoding audio…" });
          const { pcm, durationSec } = await decodeNonWavFile(file, ctx);
          tracks.push({ name: file.name, size: file.size, duration: durationSec, pcm });
          if (memoryGuard()) {
            releasePreviewUrls();
            tracks.length = 0;
            throw new Error(MEMORY_REJECT_MESSAGE);
          }
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
        releasePreviewUrls();
        setProject(null);
        setLoadInfo(null);
        setPhase("idle");
        toast({
          type: "error",
          title: message === MEMORY_REJECT_MESSAGE ? "File too large" : "Could not read file",
          message,
        });
      }
    },
    [getAudioContext, releasePreviewUrls, toast]
  );

  /* ---------------- mastering pipeline ---------------- */

  /** The actual processing work (runs after the memory gate passes). */
  const runPipeline = useCallback(async () => {
    if (!project || phase === "processing") return;

    setPhase("processing");
    setEta(null);
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

      // Tracks already hold decoded PCM (no AudioBuffer copies here). A
      // single-track project sums in place (zero-copy fast path).
      const pcmTracks: PcmData[] = project.tracks.map((t) => t.pcm);
      const originalPcm = sumTracks(pcmTracks);

      report(7, "mixing", MIXING_STATUS(0));
      const before: Metrics = await measureAll(originalPcm, (f) =>
        report(7 + f * 3, "mixing", MIXING_STATUS(f))
      );

      /* ---- Stage 2: MASTERING (10-88%) ---- */
      const lufsLabel = TARGET_LUFS_LABEL[settings.loudness] ?? settings.loudness;
      report(10, "mastering", "Initializing mastering chain…");

      // Master a copy — originalPcm stays intact for the A/B comparison.
      // The engine processes this in 0.25 s chunks, yielding to the UI.
      const work = clonePcm(originalPcm);
      const masteredPcm = await masterStereoPcm(work, {
        genre: settings.genre,
        loudness: settings.loudness,
        intensity: settings.intensity,
        vocalFocus: settings.vocalFocus,
        onProgress: (f) =>
          report(10 + f * 78, "mastering", MASTERING_STATUS(f, lufsLabel)),
      });

      /* ---- Stage 3: QC (88-100%) ---- */
      report(88, "qc", QC_STATUS(0));
      const after: Metrics = await measureAll(masteredPcm, (f) =>
        report(88 + f * 9, "qc", QC_STATUS(f))
      );

      report(97, "qc", "Preparing A/B comparison…");
      await tick(60);

      // No eager WAV blobs and no preview URLs here: the results dashboard
      // resolves compact previews + pre-computed peaks lazily on demand.
      releasePreviewUrls();

      const frames = masteredPcm.channels[0].length;
      const newSession: MasterSession = {
        settings: { ...settings },
        originalPcm,
        masteredPcm,
        before,
        after,
        durationSec: frames / masteredPcm.sampleRate,
        sampleRate: masteredPcm.sampleRate,
        elapsedSec: (performance.now() - startedAt) / 1000,
        tracks: project.tracks.map((t) => ({ name: t.name, pcm: t.pcm })),
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      setPhase(project ? "ready" : "idle");
      toast({ type: "error", title: "Processing failed", message });
    }
  }, [project, phase, settings, releasePreviewUrls, toast]);

  /** Memory gate + confirmation, then the pipeline. */
  const handleMixClick = useCallback(() => {
    if (!project || phase === "processing") return;
    const verdict = memoryVerdict(estimateProjectPeakBytes(project.tracks.map((t) => t.pcm)));
    if (verdict.level === "reject") {
      toast({
        type: "error",
        title: "File too large",
        message: MEMORY_REJECT_MESSAGE,
      });
      return;
    }
    if (verdict.level === "warn") {
      setMemoryWarning(MEMORY_WARNING_MESSAGE);
      return;
    }
    void runPipeline();
  }, [project, phase, toast, runPipeline]);

  /* ---------------- project lifecycle ---------------- */

  const clearProject = useCallback(() => {
    releasePreviewUrls();
    setProject(null);
    setSession(null);
    setLoadInfo(null);
    setPhase("idle");
  }, [releasePreviewUrls]);

  const remaster = useCallback(() => {
    // Session preview URLs/peaks live in the results dashboard and are
    // revoked with it; track previews are regenerated lazily on demand.
    releasePreviewUrls();
    setSession(null);
    setPhase("ready");
  }, [releasePreviewUrls]);

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
                  getPreviewUrl={getPreviewUrl}
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
                />
              ) : (
                <SettingsPanel
                  settings={settings}
                  onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                  onProcess={handleMixClick}
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

      {/* ---------------- Large-file confirmation ---------------- */}
      {memoryWarning && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setMemoryWarning(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Large file warning"
        >
          <div
            className="glass w-full max-w-md rounded-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <span
                className="flex h-10 w-10 flex-none items-center justify-center rounded-xl"
                style={{
                  background: "rgba(255, 196, 0, 0.15)",
                  border: "1px solid rgba(255, 196, 0, 0.35)",
                  color: "#ffc400",
                }}
              >
                <AlertTriangle size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-base font-bold text-ink">
                  Large file detected
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-mut">
                  {memoryWarning}
                </p>
              </div>
              <button
                className="btn-icon h-7 w-7 flex-none"
                onClick={() => setMemoryWarning(null)}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-ghost px-4 py-2.5 text-sm"
                onClick={() => setMemoryWarning(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary px-4 py-2.5 text-sm"
                onClick={() => {
                  setMemoryWarning(null);
                  void runPipeline();
                }}
              >
                Continue anyway
              </button>
            </div>
          </div>
        </div>
      )}
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
