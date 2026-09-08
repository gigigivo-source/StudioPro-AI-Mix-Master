"use client";

import { useState, useRef } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  DownloadCloud,
  FileArchive,
  Layers,
  Loader2,
  Music,
  Pause,
  Play,
  PlayCircle,
  SlidersHorizontal,
  StopCircle,
  Trash2,
  UploadCloud,
  XCircle,
} from "lucide-react";
import JSZip from "jszip";
import { formatBytes, formatDuration } from "@/lib/format";
import { downloadBlob } from "@/lib/exports";
import type { BatchItem, Settings, Theme } from "@/lib/types";

export function BatchQueueView({
  items,
  isProcessing,
  currentIndex,
  settings,
  theme,
  onStartBatch,
  onCancelBatch,
  onRemoveItem,
  onClearQueue,
  onNewProject,
}: {
  items: BatchItem[];
  isProcessing: boolean;
  currentIndex: number;
  settings: Settings;
  theme: Theme;
  onStartBatch: () => void;
  onCancelBatch: () => void;
  onRemoveItem: (id: string) => void;
  onClearQueue: () => void;
  onNewProject: () => void;
}) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const completedCount = items.filter((i) => i.status === "done").length;
  const hasCompleted = completedCount > 0;

  const togglePreview = (item: BatchItem) => {
    const el = audioRef.current;
    if (!el) return;

    const url = item.session?.masteredUrl;
    if (!url) return;

    if (playingId === item.id) {
      el.pause();
      setPlayingId(null);
      return;
    }

    el.src = url;
    el.play().catch(() => setPlayingId(null));
    setPlayingId(item.id);
  };

  const downloadAllMastered = async () => {
    const doneItems = items.filter((i) => i.status === "done" && i.masteredBlob);
    if (doneItems.length === 0) return;

    setDownloadingZip(true);
    try {
      const zip = new JSZip();
      for (const item of doneItems) {
        if (item.masteredBlob) {
          const dot = item.name.lastIndexOf(".");
          const base = dot === -1 ? item.name : item.name.slice(0, dot);
          zip.file(`${base}_mastered.wav`, item.masteredBlob);
        }
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipBlob, "StudioPro_Album_Masters.zip");
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="fade-up flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span
            className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl text-white"
            style={{
              background:
                "linear-gradient(135deg, var(--sp-accent) 0%, var(--sp-aqua) 120%)",
              boxShadow: "0 10px 28px -8px var(--sp-glow)",
            }}
          >
            <Layers size={24} />
          </span>
          <div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-ink">
              Batch Album / EP Mastering
            </h1>
            <p className="text-xs sm:text-sm text-mut">
              {items.length} {items.length === 1 ? "track" : "tracks"} in queue · {completedCount} mastered
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasCompleted && (
            <button
              onClick={downloadAllMastered}
              disabled={downloadingZip}
              className="btn-primary px-4 py-2 text-xs sm:text-sm"
            >
              {downloadingZip ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <DownloadCloud size={16} />
              )}
              Download Album ZIP ({completedCount})
            </button>
          )}

          <button
            onClick={onNewProject}
            disabled={isProcessing}
            className="btn-ghost px-3.5 py-2 text-xs sm:text-sm"
          >
            <UploadCloud size={15} />
            New Upload
          </button>
        </div>
      </div>

      {/* Queue card */}
      <div className="glass rounded-3xl p-5 sm:p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
            <Music size={14} />
            Track Queue ({items.length})
          </div>

          <div className="flex items-center gap-2">
            {!isProcessing ? (
              <button
                onClick={onStartBatch}
                className="btn-primary px-4 py-2 text-xs font-semibold"
              >
                <PlayCircle size={15} />
                Master All in Queue
              </button>
            ) : (
              <button
                onClick={onCancelBatch}
                className="btn-danger px-3.5 py-1.5 text-xs font-semibold"
              >
                <StopCircle size={14} />
                Cancel Batch
              </button>
            )}

            {!isProcessing && items.length > 0 && (
              <button
                onClick={onClearQueue}
                className="btn-icon h-8 w-8 text-faint hover:text-err"
                title="Clear queue"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>

        {/* List of batch tracks */}
        <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1">
          {items.map((item, idx) => {
            const isCurrent = isProcessing && currentIndex === idx;
            const isDone = item.status === "done";
            const isError = item.status === "error";
            const isPlaying = playingId === item.id;

            return (
              <div
                key={item.id}
                className={`flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 rounded-2xl border p-3.5 transition-all duration-200 ${
                  isCurrent
                    ? "border-accent bg-surface2 ring-1 ring-accent"
                    : isDone
                      ? "border-ok/30 bg-ok/5"
                      : isError
                        ? "border-err/30 bg-err/5"
                        : "border-line bg-surface"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span
                    className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-line text-xs font-bold"
                    style={{
                      background: isDone
                        ? "rgba(52, 225, 176, 0.15)"
                        : isCurrent
                          ? "var(--sp-accent)"
                          : "var(--sp-surface-2)",
                      color: isDone
                        ? "var(--sp-ok)"
                        : isCurrent
                          ? "#fff"
                          : "var(--sp-mut)",
                    }}
                  >
                    {isDone ? (
                      <CheckCircle2 size={16} />
                    ) : isCurrent ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : isError ? (
                      <AlertCircle size={16} className="text-err" />
                    ) : (
                      idx + 1
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-[11px] text-faint mt-0.5">
                      {formatBytes(item.size)}
                      {item.duration ? ` · ${formatDuration(item.duration)}` : ""}
                      {item.error ? (
                        <span className="text-err font-medium ml-1">
                          — {item.error}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>

                {/* Progress or Actions */}
                <div className="flex items-center gap-2 flex-none">
                  {isCurrent && (
                    <div className="w-24 sm:w-32">
                      <div className="h-2 overflow-hidden rounded-full bg-surface3">
                        <div
                          className="h-full rounded-full transition-all duration-150"
                          style={{
                            width: `${item.progress}%`,
                            background: "linear-gradient(90deg, var(--sp-accent), var(--sp-aqua))",
                          }}
                        />
                      </div>
                      <p className="text-[10px] text-right text-faint mt-0.5 font-medium tabular-nums">
                        {Math.round(item.progress)}%
                      </p>
                    </div>
                  )}

                  {isDone && item.session && (
                    <button
                      onClick={() => togglePreview(item)}
                      className="btn-icon h-8 w-8 rounded-full border border-line bg-surface2 text-aqua"
                      title={isPlaying ? "Pause" : "Preview Master"}
                    >
                      {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
                    </button>
                  )}

                  {isDone && item.masteredBlob && (
                    <button
                      onClick={() => {
                        const dot = item.name.lastIndexOf(".");
                        const base = dot === -1 ? item.name : item.name.slice(0, dot);
                        downloadBlob(item.masteredBlob!, `${base}_mastered.wav`);
                      }}
                      className="btn-icon h-8 w-8 text-mut hover:text-ink"
                      title="Download Master WAV"
                    >
                      <DownloadCloud size={15} />
                    </button>
                  )}

                  {!isProcessing && (
                    <button
                      onClick={() => onRemoveItem(item.id)}
                      className="btn-icon h-8 w-8 text-faint hover:text-err"
                      title="Remove from queue"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
    </div>
  );
}
