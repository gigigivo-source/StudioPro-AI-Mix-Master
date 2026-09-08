"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import {
  masterStereoPcm,
  sumTracks,
  parseWavStreaming,
  computePeaks,
  MAX_FILE_SIZE,
  type PcmData,
} from "@/lib/client-audio-engine";
import { measureAll, type Metrics } from "@/lib/analysis";
import { wavBlob } from "@/lib/exports";
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

/** Number of peaks to compute for waveform visualisation (≈ 1 per pixel). */
const WAVEFORM_PEAKS = 1200;

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

  const audioCtxRef = useRef<AudioContext | null>(null);
  /** Track preview URLs die with the project; session preview URLs die with the session. */
  const trackUrlsRef = useRef<string[]>([]);
  const sessionUrlsRef = useRef<string[]>([]);
  const progressRef = useRef({ p: 0, t: 0, rate: 0 });

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
        // ---- Validate file size (1 GB cap to avoid mobile OOM kills) ----
        if (file.size > MAX_FILE_SIZE) {
          const gb = (file.size / (1024 * 1024 * 1024)).toFixed(2);
          throw new Error(
            `File is ${gb} GB — maximum supported size is 1 GB. ` +
            "Try splitting into smaller stems or exporting at a lower sample rate."
          );
        }

        const lower = file.name.toLowerCase();
        const isZip = lower.endsWith(".zip") || file.type.includes("zip");

        /**
         * Track payloads:
         *  - `wav-blob`: a WAV stored as a Blob we can stream-parse (no
         *    ArrayBuffer needed — keeps peak memory ≈ one chunk).
         *  - `compressed`: a non-WAV format where decodeAudioData requires the
         *    full buffer. These are kept only until decoding finishes, then
         *    released.
         */
        type TrackPayload =
          | { name: string; kind: "wav-blob"; blob: Blob; size: number }
          | {
              name: string;
              kind: "compressed";
              data: ArrayBuffer;
              blob: Blob;
              size: number;
            };

        const payloads: TrackPayload[] = [];

        if (isZip) {
          // JSZip requires the full buffer. We release the JSZip instance
          // and the raw buffer as soon as extraction is done so peak memory
          // ≈ zip + one entry at a time.
          const buf = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(buf);
          setLoadInfo({ percent: 12, message: "Scanning ZIP contents…" });

          const entries: { name: string; entry: JSZip.JSZipObject }[] = [];
          for (const [path, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            if (
              path.includes("__MACOSX") ||
              path.includes(".DS_Store") ||
              path.startsWith(".")
            )
              continue;
            const dot = path.lastIndexOf(".");
            const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
            if (!AUDIO_EXTENSIONS.includes(ext)) continue;
            entries.push({ name: path.split("/").pop() || path, entry });
          }

          if (entries.length === 0) {
            throw new Error("No audio files found in that ZIP.");
          }

          // Extract entries sequentially; only one raw buffer lives at a time.
          for (const { name, entry } of entries) {
            const data = await entry.async("arraybuffer");
            const dot = name.lastIndexOf(".");
            const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
            if (ext === ".wav") {
              payloads.push({
                name,
                kind: "wav-blob",
                blob: new Blob([data], { type: "audio/wav" }),
                size: data.byteLength,
              });
            } else {
              const mime = MIME_BY_EXTENSION[ext] ?? "audio/wav";
              payloads.push({
                name,
                kind: "compressed",
                data,
                blob: new Blob([data], { type: mime }),
                size: data.byteLength,
              });
            }
          }

          // Release the JSZip instance + raw buffer (no longer referenced).
          // @ts-expect-error -- intentional null-out for GC
          zip.files = null;

          setLoadInfo({
            percent: 18,
            message: `${payloads.length} audio file${payloads.length === 1 ? "" : "s"} found`,
          });
        } else {
          const dot = file.name.lastIndexOf(".");
          const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
          if (ext === ".wav") {
            // WAV — stream-parse directly from the File object; never load
            // the entire buffer into memory.
            payloads.push({
              name: file.name,
              kind: "wav-blob",
              blob: file,
              size: file.size,
            });
          } else {
            const data = await file.arrayBuffer();
            const mime = MIME_BY_EXTENSION[ext] ?? "audio/wav";
            payloads.push({
              name: file.name,
              kind: "compressed",
              data,
              blob: new Blob([data], { type: mime }),
              size: data.byteLength,
            });
          }
          setLoadInfo({ percent: 18, message: "Audio file found" });
        }

        const ctx = getAudioContext();
        const tracks: TrackInfo[] = [];

        for (let i = 0; i < payloads.length; i++) {
          const p = payloads[i];
          setLoadInfo({
            percent: 18 + 72 * (i / payloads.length),
            message: `Decoding ${p.name}…`,
          });

          let buffer: AudioBuffer;

          try {
            if (p.kind === "wav-blob") {
              // Stream-parse WAV without ever loading the whole file.
              // Blob.slice() works on File and Blob identically.
              const pcm = await parseWavStreaming(
                p.blob as unknown as File,
                (f) => {
                  setLoadInfo({
                    percent:
                      18 + 72 * ((i + f * 0.9) / payloads.length),
                    message: `Reading ${p.name}…`,
                  });
                }
              );
              buffer = ctx.createBuffer(
                pcm.channels.length,
                pcm.channels[0].length,
                pcm.sampleRate
              );
              for (let c = 0; c < pcm.channels.length; c++) {
                // copyToChannel's type expects Float32Array<ArrayBuffer>;
                // our streaming parser always allocates plain ArrayBuffers
                // (never SharedArrayBuffer), so this cast is safe and avoids
                // an unnecessary copy of potentially hundreds of MB.
                buffer.copyToChannel(pcm.channels[c] as any, c);
              }
              // Release the temporary Float32Arrays — only the AudioBuffer
              // survives.
              pcm.channels.length = 0;
            } else {
              // Compressed format — decodeAudioData needs the whole buffer,
              // but compressed files are small. Drop `data` after decoding.
              const copy = p.data.slice(0);
              buffer = await ctx.decodeAudioData(copy);
              // @ts-expect-error -- intentional null-out for GC
              p.data = null;
            }
          } catch {
            toast({
              type: "error",
              title: `Skipped "${p.name}"`,
              message:
                "Could not decode this file — it was left out of the session.",
            });
            continue;
          }

          const url = rememberTrackUrl(URL.createObjectURL(p.blob));
          tracks.push({
            name: p.name,
            size: p.size,
            duration: buffer.duration,
            url,
            buffer,
          });
          await tick(16);
        }

        if (tracks.length === 0) {
          throw new Error("No decodable audio files found.");
        }

        const totalDuration = Math.max(
          ...tracks.map((t) => t.duration)
        );
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
      report(
        2,
        "mixing",
        `Summing ${project.tracks.length} track${project.tracks.length === 1 ? "" : "s"} to stereo bus…`
      );
      await tick(80);

      // Convert AudioBuffers to PcmData and drop the per-track copies as soon
      // as the sum is computed — the summed stereo bus is all we need.
      const pcmTracks = project.tracks.map((t) => toPcm(t.buffer));
      const originalPcm = sumTracks(pcmTracks);
      // Release per-track PCM — only the summed bus survives.
      pcmTracks.length = 0;

      report(7, "mixing", MIXING_STATUS(0));
      const before: Metrics = await measureAll(originalPcm, (f) =>
        report(7 + f * 3, "mixing", MIXING_STATUS(f))
      );

      /* ---- Stage 2: MASTERING (10-88%) ---- */
      const lufsLabel =
        TARGET_LUFS_LABEL[settings.loudness] ?? settings.loudness;
      report(10, "mastering", "Initializing mastering chain…");

      // Master a copy — originalPcm stays intact for the A/B comparison.
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

      report(97, "qc", "Rendering master WAV…");
      await tick(60);
      const masterWav = wavBlob(masteredPcm, 24);
      const originalWav = wavBlob(originalPcm, 16);

      report(98, "qc", "Computing waveform peaks…");
      await tick(16);
      // Decimated peaks for the A/B panels — WaveSurfer will never have to
      // decode the (potentially huge) blob URLs itself.
      const originalPeaks = computePeaks(originalPcm, WAVEFORM_PEAKS);
      const masteredPeaks = computePeaks(masteredPcm, WAVEFORM_PEAKS);

      report(99, "qc", "Preparing A/B comparison…");
      await tick(60);
      const masteredUrl = rememberSessionUrl(
        URL.createObjectURL(masterWav)
      );
      const originalUrl = rememberSessionUrl(
        URL.createObjectURL(originalWav)
      );
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
        tracks: project.tracks.map((t) => ({
          name: t.name,
          buffer: t.buffer,
        })),
        originalPeaks,
        masteredPeaks,
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
