"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PcmData } from "@/lib/client-audio-engine";
import type { Metrics } from "@/lib/analysis";
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

/** Results (wavesurfer / export codecs) load only after Mix & Master finishes. */
const ResultsDashboard = dynamic(
  () =>
    import("@/components/ResultsDashboard").then((m) => m.ResultsDashboard),
  { ssr: false }
);

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

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function StudioApp() {
  const { toast } = useToast();
  const { theme, toggleTheme } = useTheme();

  const [phase, setPhase] = useState<Phase>("idle");
  const [project, setProject] = useState<Project | null>(null);
  const [loadInfo, setLoadInfo] = useState<{ percent: number; message: string } | null>(null);
  const [loadFileName, setLoadFileName] = useState<string | null>(null);
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
      setLoadFileName(file.name);
      setLoadInfo({ percent: 4, message: "Reading file…" });
      await tick(16);

      try {
        const lower = file.name.toLowerCase();
        const isZip = lower.endsWith(".zip") || file.type.includes("zip");

        let raw: { name: string; data: ArrayBuffer }[] = [];

        if (isZip) {
          setLoadInfo({ percent: 6, message: "📦 Extracting ZIP…" });
          await tick(16);
          const buf = await file.arrayBuffer();
          const { default: JSZip } = await import("jszip");
          const zip = await JSZip.loadAsync(buf);
          setLoadInfo({ percent: 12, message: "📦 Scanning ZIP contents…" });
          await tick(16);

          const entries = Object.entries(zip.files).filter(([path, entry]) => {
            if (entry.dir) return false;
            if (
              path.includes("__MACOSX") ||
              path.includes(".DS_Store") ||
              path.startsWith(".")
            )
              return false;
            const dot = path.lastIndexOf(".");
            const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
            return AUDIO_EXTENSIONS.includes(ext);
          });

          for (let i = 0; i < entries.length; i++) {
            const [path, entry] = entries[i];
            setLoadInfo({
              percent: 12 + 20 * ((i + 1) / Math.max(1, entries.length)),
              message: `📦 Extracting ${path.split("/").pop()} (${i + 1}/${entries.length})…`,
            });
            const data = await entry.async("arraybuffer");
            raw.push({ name: path.split("/").pop() || path, data });
            await tick(0);
          }

          if (raw.length === 0) {
            throw new Error("No audio files found in that ZIP.");
          }
          setLoadInfo({
            percent: 34,
            message: `${raw.length} audio file${raw.length === 1 ? "" : "s"} found`,
          });
          await tick(16);
        } else {
          setLoadInfo({ percent: 12, message: "Reading audio file…" });
          const data = await file.arrayBuffer();
          raw = [{ name: file.name, data }];
          setLoadInfo({ percent: 34, message: "Audio file found" });
          await tick(16);
        }

        const ctx = getAudioContext();
        const tracks: TrackInfo[] = [];
        for (let i = 0; i < raw.length; i++) {
          const f = raw[i];
          setLoadInfo({
            percent: 34 + 60 * (i / raw.length),
            message: `🎵 Decoding stem ${i + 1}/${raw.length} — ${f.name}`,
          });
          await tick(16);

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

          const duration = buffer.duration;
          const sampleRate = buffer.sampleRate;
          // Drop decoded PCM immediately — mix re-decodes one stem at a time.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          buffer = null as unknown as AudioBuffer;

          const dot = f.name.lastIndexOf(".");
          const ext = dot === -1 ? "" : f.name.slice(dot).toLowerCase();
          const mime = MIME_BY_EXTENSION[ext] ?? "audio/wav";
          const url = rememberTrackUrl(
            URL.createObjectURL(new Blob([f.data], { type: mime }))
          );
          tracks.push({
            name: f.name,
            size: f.data.byteLength,
            duration,
            sampleRate,
            url,
            data: f.data,
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

        const mem =
          typeof navigator !== "undefined"
            ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
            : undefined;
        if (mem != null && mem < 1) {
          toast({
            type: "error",
            title: "Limited device memory",
            message:
              "Your device has limited memory. Please use a desktop browser or reduce the project size.",
          });
        } else if (mem != null && mem < 2) {
          toast({
            type: "info",
            title: "Large project on a small device",
            message:
              "This project may be large for your device. Processing may take a few minutes. For best results, use a desktop browser.",
          });
        }
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
        setLoadFileName(null);
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
      const mem =
        typeof navigator !== "undefined"
          ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
          : undefined;
      if (mem != null && mem < 1) {
        toast({
          type: "error",
          title: "Limited device memory",
          message:
            "Your device has limited memory. Please use a desktop browser or reduce the project size.",
        });
      } else if (mem != null && mem < 2) {
        toast({
          type: "info",
          title: "Processing on a small device",
          message:
            "This project may be large for your device. Processing may take a few minutes. For best results, use a desktop browser.",
        });
      }

      const nTracks = project.tracks.length;
      /* ---- Stage 1: MIXING (0-18%) — one stem at a time ---- */
      report(
        1,
        "mixing",
        `🎛️ Processing stem 1/${nTracks}…`
      );
      await tick(40);

      const {
        masterStereoPcm,
        encodeWav,
        createSilentStereo,
        accumulateStereo,
      } = await import("@/lib/client-audio-engine");
      const { measureAll } = await import("@/lib/analysis");

      const ctx = getAudioContext();
      const mixGain = 1 / Math.sqrt(nTracks);
      let originalPcm: PcmData | null = null;

      for (let i = 0; i < nTracks; i++) {
        const t = project.tracks[i];
        const pct = 2 + (14 * i) / nTracks;
        report(
          pct,
          "mixing",
          `🎛️ Processing stem ${i + 1}/${nTracks}…  (${Math.round(((i) / nTracks) * 18)}%)`
        );
        await tick(0);

        let decoded: AudioBuffer;
        try {
          decoded = await ctx.decodeAudioData(t.data.slice(0));
        } catch {
          throw new Error(`Could not decode “${t.name}” during mix.`);
        }
        const stem = toPcm(decoded);
        decoded = null as unknown as AudioBuffer;

        if (!originalPcm) {
          originalPcm = createSilentStereo(
            stem.sampleRate,
            Math.max(
              stem.channels[0].length,
              ...project.tracks.map((tr) =>
                Math.ceil(tr.duration * stem.sampleRate)
              )
            )
          );
        }
        originalPcm = accumulateStereo(originalPcm, stem, mixGain);
        stem.channels.length = 0;

        report(
          2 + (14 * (i + 1)) / nTracks,
          "mixing",
          `Processing: ${Math.round(((i + 1) / nTracks) * 18)}% (${i + 1} of ${nTracks} stems done)`
        );
        await tick(0);
      }

      if (!originalPcm) throw new Error("No audio to mix.");

      report(16, "mixing", MIXING_STATUS(0));
      const before: Metrics = await measureAll(originalPcm, (f) =>
        report(16 + f * 2, "mixing", MIXING_STATUS(f))
      );

      /* ---- Stage 2: MASTERING (18-88%) ---- */
      const lufsLabel =
        TARGET_LUFS_LABEL[settings.loudness] ?? settings.loudness;
      report(18, "mastering", "Initializing mastering chain…");

      // Master a copy — originalPcm stays intact for the A/B comparison.
      const work = clonePcm(originalPcm);
      const masteredPcm = await masterStereoPcm(work, {
        genre: settings.genre,
        loudness: settings.loudness,
        intensity: settings.intensity,
        vocalFocus: settings.vocalFocus,
        onProgress: (f) =>
          report(18 + f * 70, "mastering", MASTERING_STATUS(f, lufsLabel)),
      });

      /* ---- Stage 3: QC (88-100%) ---- */
      report(88, "qc", QC_STATUS(0));
      const after: Metrics = await measureAll(masteredPcm, (f) =>
        report(88 + f * 9, "qc", QC_STATUS(f))
      );

      report(97, "qc", "Rendering master WAV…");
      await tick(60);
      const wavBlob = (pcm: PcmData, bitDepth: 16 | 24) =>
        new Blob([encodeWav(pcm, bitDepth)], { type: "audio/wav" });
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
        tracks: project.tracks.map((t) => ({ name: t.name, data: t.data })),
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
  }, [project, phase, settings, rememberSessionUrl, toast, getAudioContext]);

  /* ---------------- project lifecycle ---------------- */

  const clearProject = useCallback(() => {
    releaseAllUrls();
    setProject(null);
    setSession(null);
    setLoadInfo(null);
    setLoadFileName(null);
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
                loadFileName={loadFileName}
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
