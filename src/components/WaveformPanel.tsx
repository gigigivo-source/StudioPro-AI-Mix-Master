"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import WaveSurfer from "wavesurfer.js";
import { Loader2, Pause, Play, Waves } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatDuration } from "@/lib/format";
import type { Theme } from "@/lib/types";

export type PanelId = "original" | "mastered";

/** Lazily-resolved playback assets for one A/B panel. */
export interface PanelAssets {
  /** Compact preview (22.05 kHz / 16-bit) Blob URL — streamed, never decoded. */
  url: string;
  /** Pre-computed waveform peaks (≤ 2000 per channel). */
  peaks: [Float32Array, Float32Array];
}

export interface WaveformHandle {
  playPause: () => void;
  pause: () => void;
  isPlaying: () => boolean;
}

interface Props {
  id: PanelId;
  tag: string;
  label: string;
  /** Duration of the full audio in seconds (rendered without decoding). */
  duration: number;
  accent: "muted" | "brand";
  active: boolean;
  theme: Theme;
  stats: { label: string; value: string }[];
  /**
   * Resolve the playback URL + pre-computed peaks on demand. WaveSurfer is
   * created from `peaks` + `duration` + the media element only, so the full
   * audio is NEVER fetched into JS memory or decoded — playback streams
   * through the <audio> element.
   */
  resolveAssets: () => Promise<PanelAssets>;
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
 * One A/B comparison panel.
 *
 * Memory rules:
 *  - Nothing is fetched or decoded when the panel mounts.
 *  - Playback creates a compact preview URL lazily (first play / show).
 *  - The waveform renders only after the user clicks "Show Waveform", and
 *    WaveSurfer is given pre-computed peaks (≤ 2000) + duration + the media
 *    element — it never decodes the audio itself.
 */
export const WaveformPanel = forwardRef<WaveformHandle, Props>(function WaveformPanel(
  {
    id,
    tag,
    label,
    duration,
    accent,
    active,
    theme,
    stats,
    resolveAssets,
    onActivate,
    onPlayState,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const assetsRef = useRef<PanelAssets | null>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [showWave, setShowWave] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  /** Create (once) the media element + compact preview URL. */
  const ensureAssets = useCallback(async (): Promise<{ audio: HTMLAudioElement; assets: PanelAssets }> => {
    if (audio) return { audio, assets: assetsRef.current! };
    const assets = await resolveAssets();
    assetsRef.current = assets;
    const el = new Audio();
    el.preload = "auto";
    el.src = assets.url;
    setAudio(el);
    return { audio: el, assets };
  }, [audio, resolveAssets]);

  /* Media-element state (used before WaveSurfer exists). */
  useEffect(() => {
    if (!audio) return;
    const onPlay = () => {
      setPlaying(true);
      onPlayState(id, true);
    };
    const onPause = () => {
      setPlaying(false);
      onPlayState(id, false);
    };
    const onEnded = () => {
      setPlaying(false);
      onPlayState(id, false);
      setTime(duration);
    };
    const onTime = () => setTime(audio.currentTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTime);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTime);
    };
  }, [audio, duration, id, onPlayState]);

  /* Pause the media element whenever the panel unmounts. */
  useEffect(
    () => () => {
      audio?.pause();
    },
    [audio]
  );

  /*
   * WaveSurfer mount — only when the user asked for the waveform. It renders
   * from pre-computed peaks + duration and plays through the media element;
   * the full audio is never fetched or decoded by WaveSurfer.
   */
  useEffect(() => {
    if (!showWave || !audio) return;
    let cancelled = false;
    let ws: WaveSurfer | null = null;

    (async () => {
      const assets = assetsRef.current ?? (await ensureAssets()).assets;
      if (cancelled || !containerRef.current) return;
      const colors = palette(accent, theme);
      ws = WaveSurfer.create({
        container: containerRef.current,
        media: audio,
        peaks: [assets.peaks[0], assets.peaks[1]],
        duration,
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
        autoCenter: false,
        interact: true,
      });
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
      ws.on("error", () => setFailed(true));
      ws.on("ready", () => {
        if (!cancelled) {
          setTime(audio.currentTime);
          setReady(true);
        }
      });
      wsRef.current = ws;
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      wsRef.current = null;
      // destroy() does not touch the external media element (isExternalMedia);
      // we pause it ourselves. The preview URL is owned by the parent and
      // revoked there.
      ws?.destroy();
      audio.pause();
    };
  }, [showWave, audio, accent, theme, duration, id, onPlayState, ensureAssets]);

  const togglePlay = useCallback(async () => {
    onActivate(id);
    if (failed) return;
    try {
      if (wsRef.current) {
        void wsRef.current.playPause();
        return;
      }
      setPreparing(true);
      const { audio: el } = await ensureAssets();
      if (el.paused) {
        await el.play();
      } else {
        el.pause();
      }
    } catch {
      setFailed(true);
    } finally {
      setPreparing(false);
    }
  }, [id, failed, onActivate, ensureAssets]);

  const showWaveform = useCallback(async () => {
    if (failed || showWave) return;
    try {
      setPreparing(true);
      await ensureAssets();
      setShowWave(true);
    } catch {
      setFailed(true);
    } finally {
      setPreparing(false);
    }
  }, [failed, showWave, ensureAssets]);

  useImperativeHandle(ref, () => ({
    playPause: () => {
      void togglePlay();
    },
    pause: () => {
      wsRef.current?.pause();
      audio?.pause();
    },
    isPlaying: () =>
      wsRef.current ? wsRef.current.isPlaying() : audio ? !audio.paused : false,
  }));

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
            void togglePlay();
          }}
          className="btn-icon h-9 w-9 flex-none rounded-full border border-line bg-surface2"
          style={{ color: brand ? "var(--sp-aqua)" : "var(--sp-mut)" }}
          aria-label={`${playing ? "Pause" : "Play"} ${label}`}
        >
          {preparing && !playing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} className="ml-0.5" />
          )}
        </button>
      </div>

      <div className="relative mt-3 h-24">
        {failed ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border border-line bg-surface2 text-xs font-medium text-mut">
            Could not render this waveform
          </div>
        ) : showWave ? (
          <>
            <div ref={containerRef} className="h-full w-full" />
            {!ready && (
              <div className="absolute inset-0 z-10 flex items-center">
                <Skeleton className="h-16 w-full" />
              </div>
            )}
          </>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void showWaveform();
            }}
            className="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line bg-surface text-xs font-medium text-mut transition-colors duration-150 hover:border-line-strong hover:text-ink"
            aria-label={`Show ${label} waveform`}
          >
            {preparing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Waves size={16} />
            )}
            {preparing ? "Preparing waveform…" : "Show Waveform"}
          </button>
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
