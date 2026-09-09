"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type WaveSurfer from "wavesurfer.js";
import { Pause, Play } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDuration } from "@/lib/format";
import type { Theme } from "@/lib/types";

export type PanelId = "original" | "mastered";

export interface WaveformHandle {
  playPause: () => void;
  pause: () => void;
  isPlaying: () => boolean;
}

interface Props {
  id: PanelId;
  tag: string;
  label: string;
  url: string;
  accent: "muted" | "brand";
  active: boolean;
  theme: Theme;
  stats: { label: string; value: string }[];
  onActivate: (id: PanelId) => void;
  onPlayState: (id: PanelId, playing: boolean) => void;
}

function palette(accent: "muted" | "brand", theme: Theme) {
  const light = theme === "light";
  if (accent === "brand") {
    return {
      wave: light ? "rgba(90, 80, 240, 0.35)" : "rgba(108, 99, 255, 0.42)",
      progress: light ? "#5A50F0" : "#7A6FFF",
      cursor: light ? "#009FD0" : "#00D4FF",
    };
  }
  return {
    wave: light ? "rgba(100, 116, 139, 0.32)" : "rgba(148, 163, 184, 0.34)",
    progress: light ? "#64748B" : "#9AA6B8",
    cursor: light ? "#009FD0" : "#00D4FF",
  };
}

/**
 * One A/B comparison panel: Wavesurfer.js waveform + transport.
 * Pure presentation; the parent orchestrates exclusive playback.
 */
export const WaveformPanel = forwardRef<WaveformHandle, Props>(function WaveformPanel(
  { id, tag, label, url, accent, active, theme, stats, onActivate, onPlayState },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  useImperativeHandle(ref, () => ({
    playPause: () => wsRef.current?.playPause(),
    pause: () => wsRef.current?.pause(),
    isPlaying: () => wsRef.current?.isPlaying() ?? false,
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setReady(false);
    setFailed(false);
    setTime(0);
    setDuration(0);
    setPlaying(false);

    const colors = palette(accent, theme);
    let cancelled = false;
    let ws: WaveSurfer | null = null;

    void import("wavesurfer.js").then((mod) => {
      if (cancelled || !containerRef.current) return;
      const WaveSurferCtor = mod.default;
      ws = WaveSurferCtor.create({
        container: el,
        url,
        waveColor: colors.wave,
        progressColor: colors.progress,
        cursorColor: colors.cursor,
        cursorWidth: 2,
        height: 96,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        autoScroll: false,
        interact: true,
      });

      ws.on("decode", (dur) => setDuration(dur));
      ws.on("ready", () => setReady(true));
      ws.on("error", () => setFailed(true));
      ws.on("timeupdate", (t) => setTime(t));
      ws.on("play", () => {
        setPlaying(true);
        onPlayState(id, true);
      });
      ws.on("pause", () => {
        setPlaying(false);
        onPlayState(id, false);
      });
      ws.on("finish", () => {
        setPlaying(false);
        onPlayState(id, false);
      });

      wsRef.current = ws;
    });

    return () => {
      cancelled = true;
      ws?.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, theme, accent]);

  const brand = accent === "brand";

  return (
    <div
      onClick={() => onActivate(id)}
      className={`glass cursor-pointer rounded-2xl p-4 transition-all duration-200 ${
        active ? "ring-accent" : "hover:border-line-strong"
      }`}
      style={{ userSelect: "none" }}
      aria-label={`${label} waveform panel`}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg font-display text-sm font-bold"
          style={
            brand
              ? {
                  background:
                    "linear-gradient(135deg, var(--sp-accent), var(--sp-aqua))",
                  color: "#fff",
                  boxShadow: "0 6px 18px -6px var(--sp-glow)",
                }
              : {
                  background: "var(--sp-surface-2)",
                  border: "1px solid var(--sp-line)",
                  color: "var(--sp-mut)",
                }
          }
        >
          {tag}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{label}</p>
          <p className="text-[11px] font-medium tabular-nums text-faint">
            {stats.map((s) => s.value).join(" · ")}
          </p>
        </div>
        <span className="hidden text-[11px] font-medium tabular-nums text-faint sm:block">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onActivate(id);
            wsRef.current?.playPause();
          }}
          className="btn-icon h-9 w-9 flex-none rounded-full border border-line bg-surface2"
          style={{ color: brand ? "var(--sp-aqua)" : "var(--sp-mut)" }}
          aria-label={`${playing ? "Pause" : "Play"} ${label}`}
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
      </div>

      <div className="relative mt-3 h-24">
        <div ref={containerRef} className="h-full w-full" />
        {failed ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-line bg-surface2 text-xs font-medium text-mut">
            Could not render this waveform
          </div>
        ) : (
          !ready && (
            <div className="absolute inset-0 z-10 flex items-center">
              <Skeleton className="h-16 w-full" />
            </div>
          )
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {stats.map((s) => (
          <span
            key={s.label}
            className="flex items-baseline gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5"
          >
            <span className="text-[10px] font-bold tracking-wider text-faint">
              {s.label}
            </span>
            <span className="text-[11px] font-semibold tabular-nums text-mut">
              {s.value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
});
