"use client";

import { useEffect, useRef, useState } from "react";
import { Music, Pause, Play } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { EqualizerBars } from "@/components/ui/EqualizerBars";
import { formatBytes, formatDuration } from "@/lib/format";
import type { TrackInfo } from "@/lib/types";

/**
 * Per-track raw preview list. One shared <audio> element; only one row
 * plays at a time. Shows skeleton rows while the project is decoding.
 */
export function TrackList({
  tracks,
  loading,
}: {
  tracks: TrackInfo[] | null;
  loading: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);

  // Stop any preview when the list goes away.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

  const toggle = (index: number, url: string) => {
    const el = audioRef.current;
    if (!el) return;
    if (playingIndex === index) {
      el.pause();
      setPlayingIndex(null);
      return;
    }
    if (el.src !== url) {
      el.src = url;
    }
    void el.play().catch(() => setPlayingIndex(null));
    setPlayingIndex(index);
  };

  if (loading || !tracks) {
    return (
      <section className="glass rounded-3xl p-5 sm:p-6">
        <p className="mb-4 text-[11px] font-bold tracking-[0.14em] text-faint">
          TRACKS
        </p>
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2.5 w-1/4" />
              </div>
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="glass rounded-3xl p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[11px] font-bold tracking-[0.14em] text-faint">
          TRACKS
          <span className="ml-2 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-mut">
            {tracks.length}
          </span>
        </p>
        <p className="text-[11px] font-medium text-faint">
          {formatDuration(
            tracks.reduce((acc, t) => Math.max(acc, t.duration), 0)
          )}{" "}
          total
        </p>
      </div>

      <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
        {tracks.map((t, i) => {
          const isPlaying = playingIndex === i;
          return (
            <li
              key={`${t.name}-${i}`}
              className={`group flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-150 ${
                isPlaying
                  ? "border-accent/60 bg-surface2"
                  : "border-transparent hover:border-line hover:bg-surface"
              }`}
            >
              <span
                className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-line bg-surface"
                style={{ color: isPlaying ? "var(--sp-aqua)" : "var(--sp-mut)" }}
              >
                <Music size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink" title={t.name}>
                  {t.name}
                </p>
                <p className="text-[11px] text-faint">
                  {formatDuration(t.duration)} · {formatBytes(t.size)}
                </p>
              </div>
              {isPlaying && <EqualizerBars className="mr-1 hidden sm:inline-flex" />}
              <button
                onClick={() => toggle(i, t.url)}
                className="btn-icon h-8 w-8 flex-none rounded-full border border-line bg-surface2"
                aria-label={isPlaying ? `Pause ${t.name}` : `Play ${t.name}`}
              >
                {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
              </button>
            </li>
          );
        })}
      </ul>

      <audio ref={audioRef} onEnded={() => setPlayingIndex(null)} preload="auto" />
    </section>
  );
}
