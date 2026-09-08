"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  FileArchive,
  FileAudio,
  FileAudio2,
  FileMusic,
  FileText,
  Gauge,
  Keyboard,
  Loader2,
  Settings2,
  UploadCloud,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useToast } from "@/components/Toast";
import {
  WaveformPanel,
  type PanelId,
  type WaveformHandle,
} from "@/components/WaveformPanel";
import {
  baseName,
  buildPdfReport,
  buildStemsZip,
  downloadBlob,
  encodeMp3,
  wavBlob,
} from "@/lib/exports";
import { formatDb, formatLufs } from "@/lib/format";
import type { MasterSession, Theme } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Metric card                                                         */
/* ------------------------------------------------------------------ */

type Tone = "accent" | "aqua" | "neutral";

const TONE_CLASS: Record<Tone, { bg: string; color: string }> = {
  accent: { bg: "rgba(108, 99, 255, 0.14)", color: "var(--sp-accent)" },
  aqua: { bg: "rgba(0, 212, 255, 0.12)", color: "var(--sp-aqua)" },
  neutral: { bg: "var(--sp-surface-2)", color: "var(--sp-mut)" },
};

function MetricCard({
  icon: Icon,
  label,
  before,
  after,
  delta,
  tone,
  delay,
}: {
  icon: LucideIcon;
  label: string;
  before: string;
  after: string;
  delta: string;
  tone: Tone;
  delay: number;
}) {
  return (
    <div
      className="glass fade-up rounded-2xl p-4"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 text-faint">
        <Icon size={14} />
        <span className="text-[10px] font-bold uppercase tracking-[0.14em]">
          {label}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-[13px] font-medium tabular-nums text-mut">
          {before}
        </span>
        <ArrowRight size={13} className="flex-none text-faint" />
        <span className="font-display text-xl font-bold tabular-nums text-ink">
          {after}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
          style={{
            background: TONE_CLASS[tone].bg,
            color: tone === "aqua" || tone === "accent" ? TONE_CLASS[tone].color : "var(--sp-mut)",
          }}
        >
          {delta}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Download buttons                                                    */
/* ------------------------------------------------------------------ */

interface DownloadDef {
  id: string;
  icon: LucideIcon;
  title: string;
  sub: string;
  tip: string;
  toastTitle: string;
}

const DOWNLOADS: DownloadDef[] = [
  {
    id: "wav16",
    icon: FileAudio,
    title: "WAV 16-bit",
    sub: "lossless · broadcast",
    tip: "16-bit WAV — broadcast and DAW compatible",
    toastTitle: "WAV 16-bit exported",
  },
  {
    id: "wav24",
    icon: FileAudio2,
    title: "WAV 24-bit",
    sub: "lossless · master",
    tip: "24-bit WAV — highest fidelity master",
    toastTitle: "WAV 24-bit exported",
  },
  {
    id: "mp3",
    icon: FileMusic,
    title: "MP3 320kbps",
    sub: "LAME · CBR",
    tip: "MP3 encoded with LAME at maximum 320 kbps CBR",
    toastTitle: "MP3 320 kbps exported",
  },
  {
    id: "stems",
    icon: FileArchive,
    title: "Stems ZIP",
    sub: "per-track WAVs",
    tip: "ZIP of every source track as its own 24-bit WAV",
    toastTitle: "Stems ZIP exported",
  },
  {
    id: "pdf",
    icon: FileText,
    title: "PDF Report",
    sub: "full analysis",
    tip: "Mastering report with metrics, settings and waveforms",
    toastTitle: "PDF report generated",
  },
];

/* ------------------------------------------------------------------ */

export function ResultsDashboard({
  session,
  sourceName,
  theme,
  onNewProject,
  onRemaster,
}: {
  session: MasterSession;
  sourceName: string;
  theme: Theme;
  onNewProject: () => void;
  onRemaster: () => void;
}) {
  const { toast } = useToast();

  const origRef = useRef<WaveformHandle>(null);
  const mastRef = useRef<WaveformHandle>(null);
  const [active, setActive] = useState<PanelId>("mastered");
  const [playing, setPlaying] = useState<Record<PanelId, boolean>>({
    original: false,
    mastered: false,
  });
  const [busy, setBusy] = useState<Record<string, number>>({});

  const playState = useCallback(
    (id: PanelId, isPlaying: boolean) =>
      setPlaying((p) => ({ ...p, [id]: isPlaying })),
    []
  );

  /* Exclusive playback: starting one panel pauses the other. */
  const requestPlay = useCallback((id: PanelId) => {
    setActive(id);
    const self = id === "original" ? origRef : mastRef;
    const other = id === "original" ? mastRef : origRef;
    if (other.current?.isPlaying()) other.current.pause();
    self.current?.playPause();
  }, []);

  /* Space = play/pause the active panel. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          tag === "A" ||
          t.isContentEditable
        )
          return;
      }
      e.preventDefault();
      requestPlay(active);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, requestPlay]);

  /* ---------------- downloads ---------------- */

  const base = baseName(sourceName);

  const run = useCallback(
    async (
      id: string,
      fn: (onProgress?: (f: number) => void) => Promise<void>,
      successTitle: string
    ) => {
      setBusy((b) => (b[id] != null ? b : { ...b, [id]: 0 }));
      try {
        await fn((f) => setBusy((b) => ({ ...b, [id]: f })));
        toast({ type: "success", title: successTitle });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast({ type: "error", title: "Export failed", message });
      } finally {
        setBusy((b) => {
          const copy = { ...b };
          delete copy[id];
          return copy;
        });
      }
    },
    [toast]
  );

  const onDownload = (def: DownloadDef) => {
    switch (def.id) {
      case "wav16":
        void run(def.id, async () => {
          downloadBlob(wavBlob(session.masteredPcm, 16), `${base}_mastered.wav`);
        }, def.toastTitle);
        break;
      case "wav24":
        void run(def.id, async () => {
          downloadBlob(wavBlob(session.masteredPcm, 24), `${base}_mastered.wav`);
        }, def.toastTitle);
        break;
      case "mp3":
        void run(
          def.id,
          async (p) => {
            const blob = await encodeMp3(session.masteredPcm, 320, p);
            downloadBlob(blob, `${base}_mastered.mp3`);
          },
          def.toastTitle
        );
        break;
      case "stems":
        void run(
          def.id,
          async (p) => {
            const blob = await buildStemsZip(session.tracks, p);
            downloadBlob(blob, `${base}_stems.zip`);
          },
          def.toastTitle
        );
        break;
      case "pdf":
        void run(def.id, async () => {
          const doc = buildPdfReport({
            sourceName,
            settings: session.settings,
            trackCount: session.tracks.length,
            durationSec: session.durationSec,
            sampleRate: session.sampleRate,
            elapsedSec: session.elapsedSec,
            before: session.before,
            after: session.after,
            originalPcm: session.originalPcm,
            masteredPcm: session.masteredPcm,
          });
          doc.save(`${base}_mastering-report.pdf`);
        }, def.toastTitle);
        break;
    }
  };

  /* ---------------- metrics ---------------- */

  const { before, after } = session;
  const lufsd = after.lufs - before.lufs;
  const tpd = after.truePeakDb - before.truePeakDb;
  const drd = after.dynamicRange - before.dynamicRange;
  const wd = after.stereoWidth - before.stereoWidth;

  const genreLabel = session.settings.genre.replace(/_/g, " ");
  const loudnessLabel = session.settings.loudness.replace(/_/g, " ");

  return (
    <div className="space-y-6">
      {/* ---------------- Header ---------------- */}
      <div className="fade-up flex flex-wrap items-center gap-4">
        <span
          className="pop flex h-12 w-12 flex-none items-center justify-center rounded-2xl"
          style={{
            background:
              "linear-gradient(135deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 120%)",
            boxShadow: "0 12px 32px -10px var(--sp-glow)",
          }}
        >
          <CircleCheck size={24} strokeWidth={2.2} className="text-white" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Mastering complete
          </h1>
          <p className="mt-0.5 text-sm text-mut">
            {session.tracks.length} {session.tracks.length === 1 ? "track" : "tracks"}{" "}
            summed · {genreLabel} · {loudnessLabel} target · rendered in{" "}
            {session.elapsedSec.toFixed(1)}s
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={onRemaster} className="btn-ghost px-4 py-2.5 text-sm">
            <Settings2 size={15} />
            Change settings
          </button>
          <button onClick={onNewProject} className="btn-ghost px-4 py-2.5 text-sm">
            <UploadCloud size={15} />
            New project
          </button>
        </div>
      </div>

      {/* ---------------- A/B comparison ---------------- */}
      <div className="fade-up" style={{ animationDelay: "60ms" }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
            A/B Comparison
          </h2>
          <p className="hidden items-center gap-1.5 text-[11px] font-medium text-faint sm:flex">
            <Keyboard size={12} />
            Space — play / pause active panel
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <WaveformPanel
            ref={origRef}
            id="original"
            tag="A"
            label="Original"
            url={session.originalUrl}
            accent="muted"
            active={active === "original"}
            theme={theme}
            peaks={session.originalPeaks}
            stats={[
              { label: "LUFS", value: formatLufs(before.lufs) },
              { label: "TP", value: `${formatDb(before.truePeakDb)} dBTP` },
            ]}
            onActivate={setActive}
            onPlayState={playState}
          />
          <WaveformPanel
            ref={mastRef}
            id="mastered"
            tag="B"
            label="Mastered"
            url={session.masteredUrl}
            accent="brand"
            active={active === "mastered"}
            theme={theme}
            peaks={session.masteredPeaks}
            stats={[
              { label: "LUFS", value: formatLufs(after.lufs) },
              { label: "TP", value: `${formatDb(after.truePeakDb)} dBTP` },
            ]}
            onActivate={setActive}
            onPlayState={playState}
          />
        </div>
      </div>

      {/* ---------------- Metrics ---------------- */}
      <div className="fade-up" style={{ animationDelay: "120ms" }}>
        <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
          Loudness Analysis
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={Gauge}
            label="Integrated LUFS"
            before={formatLufs(before.lufs)}
            after={formatLufs(after.lufs)}
            delta={`${lufsd >= 0 ? "+" : "−"}${Math.abs(lufsd).toFixed(1)}`}
            tone="accent"
            delay={0}
          />
          <MetricCard
            icon={Zap}
            label="True Peak"
            before={`${formatDb(before.truePeakDb)} dBTP`}
            after={`${formatDb(after.truePeakDb)} dBTP`}
            delta={`${tpd >= 0 ? "+" : "−"}${Math.abs(tpd).toFixed(1)}`}
            tone="aqua"
            delay={60}
          />
          <MetricCard
            icon={Activity}
            label="Dynamic Range"
            before={`${before.dynamicRange.toFixed(1)} dB`}
            after={`${after.dynamicRange.toFixed(1)} dB`}
            delta={`${drd >= 0 ? "+" : "−"}${Math.abs(drd).toFixed(1)}`}
            tone="neutral"
            delay={120}
          />
          <MetricCard
            icon={Waves}
            label="Stereo Width"
            before={`${before.stereoWidth}%`}
            after={`${after.stereoWidth}%`}
            delta={`${wd >= 0 ? "+" : "−"}${Math.abs(wd)}`}
            tone="accent"
            delay={180}
          />
        </div>
      </div>

      {/* ---------------- Downloads ---------------- */}
      <div
        className="glass fade-up rounded-2xl p-5"
        style={{ animationDelay: "180ms" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
            Export
          </h2>
          <p className="text-[11px] font-medium text-faint">
            All formats render locally, on demand
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {DOWNLOADS.map((def) => {
            const Icon = def.icon;
            const b = busy[def.id];
            const working = b != null;
            return (
              <Tooltip key={def.id} label={def.tip} width={230} fullWidth>
                <button
                  onClick={() => onDownload(def)}
                  disabled={working}
                  className="group flex w-full flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-4 transition-all duration-150 hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface2 disabled:cursor-wait disabled:opacity-80"
                >
                  {working ? (
                    <span className="flex items-center gap-2">
                      <Loader2
                        size={18}
                        className="animate-spin"
                        style={{ color: "var(--sp-aqua)" }}
                      />
                      {b > 0 && b < 1 && (
                        <span className="text-xs font-bold tabular-nums text-mut">
                          {Math.round(b * 100)}%
                        </span>
                      )}
                    </span>
                  ) : (
                    <Icon
                      size={19}
                      className="transition-colors duration-150"
                      style={{ color: "var(--sp-mut)" }}
                    />
                  )}
                  <span className="text-[13px] font-semibold text-ink">
                    {def.title}
                  </span>
                  <span className="text-[10px] font-medium text-faint">
                    {def.sub}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
