"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import type { PcmData } from "@/lib/client-audio-engine";
import {
  PIPELINE_STAGES,
  processAudioClientSide,
  type PipelineLog,
  type QaResult,
  type StageStatus,
} from "@/lib/audio-processors";
import { wavBlob } from "@/lib/exports";
import type {
  MasterSession,
  Phase,
  Project,
  Settings,
  TrackInfo,
} from "@/lib/types";
import { Header } from "@/components/Header";
import { useTheme } from "@/hooks/useTheme";
import { ToastProvider, useToast } from "@/components/Toast";
import { UploadZone } from "@/components/UploadZone";
import { TrackList } from "@/components/TrackList";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PipelinePanel } from "@/components/PipelinePanel";
import { QAResult } from "@/components/QAResult";
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

interface PipelineUI {
  progress: number;
  active: number;
  status: string;
  stages: StageStatus[];
  logs: PipelineLog[];
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
  const [pipeline, setPipeline] = useState<PipelineUI | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [session, setSession] = useState<MasterSession | null>(null);
  const [qa, setQa] = useState<QaResult | null>(null);
  const [qaAttempts, setQaAttempts] = useState(0);

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
      setQa(null);
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

  /* ---------------- professional mastering pipeline ---------------- */

  const startProcess = useCallback(async () => {
    if (!project || phase === "processing") return;

    setPhase("processing");
    setSession(null);
    setQa(null);
    setEta(null);
    progressRef.current = { p: 0, t: performance.now(), rate: 0 };

    // Live UI state mutated by engine callbacks, published via setPipeline.
    const logs: PipelineLog[] = [];
    const stageArr: StageStatus[] = PIPELINE_STAGES.map((s) => ({
      id: s.id,
      state: "pending",
      note: "",
    }));
    const prog = { p: 0, active: 0, status: "Initializing the mastering chain…" };
    const publish = () =>
      setPipeline({
        progress: prog.p,
        active: prog.active,
        status: prog.status,
        stages: stageArr.map((s) => ({ ...s })),
        logs: logs.slice(-400),
      });
    publish();

    /** Overall progress + EMA rate for the ETA estimate. */
    const report = (fraction: number, active: number, status: string) => {
      prog.p = fraction;
      prog.active = active;
      prog.status = status;
      const now = performance.now();
      const ref = progressRef.current;
      const dt = now - ref.t;
      if (dt > 150 && fraction > ref.p + 0.01) {
        const inst = (fraction - ref.p) / dt; // fraction per ms
        ref.rate = ref.rate === 0 ? inst : ref.rate * 0.6 + inst * 0.4;
        ref.t = now;
        ref.p = fraction;
        setEta(Math.max(0, (1 - fraction) / ref.rate / 1000));
      }
      publish();
    };

    const startedAt = performance.now();

    try {
      const stems = project.tracks.map((t) => ({ name: t.name, pcm: toPcm(t.buffer) }));

      const result = await processAudioClientSide(
        stems,
        {
          genre: settings.genre,
          loudness: settings.loudness,
          intensity: settings.intensity,
          vocalFocus: settings.vocalFocus,
        },
        {
          onProgress: (f, active, status) => report(f * 100, active, status),
          onStage: (s) => {
            const i = stageArr.findIndex((x) => x.id === s.id);
            if (i >= 0) stageArr[i] = { id: s.id, state: s.state, note: s.note };
            publish();
          },
          onLog: (l) => {
            logs.push(l);
            publish();
          },
        }
      );

      const masteredPcm = result.mastered;
      const originalPcm = result.original;

      report(97, 9, "Rendering master WAV…");
      await tick(40);
      const masterWav = wavBlob(masteredPcm, 24);
      const originalWav = wavBlob(originalPcm, 16);

      report(99, 9, "Preparing A/B comparison…");
      await tick(40);
      const masteredUrl = rememberSessionUrl(URL.createObjectURL(masterWav));
      const originalUrl = rememberSessionUrl(URL.createObjectURL(originalWav));

      const newSession: MasterSession = {
        settings: { ...settings },
        originalPcm,
        originalUrl,
        masteredPcm,
        masteredUrl,
        before: result.before,
        after: result.after,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        elapsedSec: (performance.now() - startedAt) / 1000,
        tracks: project.tracks.map((t) => ({ name: t.name, buffer: t.buffer })),
      };

      await tick(250);
      setPipeline(null);
      setSession(newSession);
      setQa(result.qa);
      setQaAttempts(result.qaAttempts);
      setEta(null);
      setPhase("done");
      toast({
        type: "success",
        title: "Mastering complete",
        message: result.qa.passed
          ? "Quality check passed — A/B comparison ready."
          : "Master ready — review the quality notes before exporting.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      setPipeline(null);
      setPhase(project ? "ready" : "idle");
      toast({ type: "error", title: "Processing failed", message });
    }
  }, [project, phase, settings, rememberSessionUrl, toast]);

  /* ---------------- project lifecycle ---------------- */

  const clearProject = useCallback(() => {
    releaseAllUrls();
    setProject(null);
    setSession(null);
    setQa(null);
    setPipeline(null);
    setLoadInfo(null);
    setPhase("idle");
  }, [releaseAllUrls]);

  const remaster = useCallback(() => {
    releaseSessionUrls(); // drops the session's preview URLs only
    setSession(null);
    setQa(null);
    setPhase("ready");
  }, [releaseSessionUrls]);

  /* ---------------- render ---------------- */

  return (
    <div className="min-h-dvh">
      <Header theme={theme} onToggleTheme={toggleTheme} />

      <main className="mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-6">
        {phase === "done" && session ? (
          <div className="space-y-5">
            {qa && <QAResult qa={qa} attempts={qaAttempts} />}
            <ResultsDashboard
              session={session}
              sourceName={project?.fileName ?? "master"}
              theme={theme}
              onNewProject={clearProject}
              onRemaster={remaster}
            />
          </div>
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
                pipeline ? (
                  <PipelinePanel pipeline={pipeline} eta={eta} />
                ) : (
                  <div className="glass rounded-3xl p-6 text-sm font-medium text-mut">
                    Preparing the pipeline…
                  </div>
                )
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
        StudioPro — professional mix &amp; master · 10-stage pipeline runs 100% in
        your browser · audio never leaves your device
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
