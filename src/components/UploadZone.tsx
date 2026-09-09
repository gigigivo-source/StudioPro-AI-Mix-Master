"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudUpload,
  FileArchive,
  FolderOpen,
  Layers,
  ShieldCheck,
  Timer,
  X,
} from "lucide-react";
import { formatBytes, formatDuration } from "@/lib/format";
import type { Phase, Project } from "@/lib/types";

const ACCEPT =
  ".zip,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff,.aif,.opus,.webm,audio/*,application/zip,application/x-zip-compressed";

interface LoadInfo {
  percent: number;
  message: string;
}

export function UploadZone({
  phase,
  project,
  loadInfo,
  loadFileName,
  onFileSelected,
  onClear,
}: {
  phase: Phase;
  project: Project | null;
  loadInfo: LoadInfo | null;
  loadFileName?: string | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const loading = phase === "loading";
  const locked = phase === "processing" || phase === "done";

  /* Keep the browser from opening the file when it's dropped outside the zone. */
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (locked) return;
      const file = e.dataTransfer.files?.[0];
      if (file) onFileSelected(file);
    },
    [locked, onFileSelected]
  );

  const showEmpty = phase === "idle" && !project;

  /* ------------------------------------------------ empty / drop zone */
  if (showEmpty) {
    return (
      <section
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        className={`glass flex min-h-[300px] flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-12 text-center transition-all duration-300 ${
          dragging ? "drag-active scale-[1.01]" : "border-line"
        }`}
        aria-label="Upload area"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileSelected(f);
            e.target.value = "";
          }}
        />

        <span
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl text-white transition-transform duration-300"
          style={{
            background:
              "linear-gradient(135deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 125%)",
            boxShadow: "0 14px 40px -10px var(--sp-glow), 0 0 30px -8px var(--sp-glow-aqua)",
            transform: dragging ? "scale(1.12) rotate(-4deg)" : undefined,
          }}
        >
          <CloudUpload size={30} strokeWidth={2} />
        </span>

        <h2 className="font-display text-xl font-bold tracking-tight text-ink">
          {dragging ? "Release to load" : "Drop your session ZIP here"}
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-mut">
          FL Studio Mobile project export, or a bundle of stems —
          <span className="font-medium text-ink"> WAV · MP3 · FLAC · OGG · M4A</span>
        </p>

        <button
          onClick={() => inputRef.current?.click()}
          className="btn-ghost mt-6 px-5 py-2.5 text-sm"
        >
          <FolderOpen size={16} style={{ color: "var(--sp-aqua)" }} />
          Browse files
        </button>

        <p className="mt-6 flex items-center gap-1.5 text-[11px] font-medium text-faint">
          <ShieldCheck size={12} style={{ color: "var(--sp-ok)" }} />
          Processed locally in your browser — nothing is uploaded
        </p>
      </section>
    );
  }

  /* ------------------------------------------------ loading (no project yet) */
  if (showLoadingCard) {
    return (
      <section className="glass rounded-3xl p-5 sm:p-6" aria-busy>
        <div className="flex items-start gap-4">
          <span
            className="flex h-12 w-12 flex-none items-center justify-center rounded-xl"
            style={{
              background:
                "linear-gradient(135deg, rgba(108,99,255,0.22), rgba(0,212,255,0.14))",
              border: "1px solid var(--sp-line)",
              color: "var(--sp-aqua)",
            }}
          >
            <FileArchive size={22} strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">
              {loadFileName || "Loading session…"}
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--sp-aqua)" }}>
              <span className="blink inline-block h-1.5 w-1.5 rounded-full bg-aqua" />
              {loadInfo?.message ?? "Reading file…"}
            </p>
            <div className="mt-3">
              <div className="h-2 overflow-hidden rounded-full bg-surface2">
                <div
                  className="sheen h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.min(100, loadInfo?.percent ?? 4)}%`,
                    background:
                      "linear-gradient(90deg, var(--sp-accent), var(--sp-aqua))",
                  }}
                />
              </div>
              <p className="mt-1.5 text-right text-[11px] font-medium tabular-nums text-faint">
                {Math.round(loadInfo?.percent ?? 0)}%
              </p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  /* ------------------------------------------------ file card (loaded) */
  if (project) {
    const trackCount = project.tracks.length;
    return (
      <section className="glass rounded-3xl p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span
            className="flex h-12 w-12 flex-none items-center justify-center rounded-xl"
            style={{
              background:
                "linear-gradient(135deg, rgba(108,99,255,0.22), rgba(0,212,255,0.14))",
              border: "1px solid var(--sp-line)",
              color: "var(--sp-aqua)",
            }}
          >
            <FileArchive size={22} strokeWidth={2} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink" title={project.fileName}>
              {project.fileName}
            </p>

            {/* Meta row: size · duration · track count */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-mut">
              <span className="font-medium">{formatBytes(project.fileSize)}</span>
              <span className="flex items-center gap-1">
                <Timer size={12} className="text-faint" />
                {formatDuration(project.totalDuration)}
              </span>
              <span className="flex items-center gap-1">
                <Layers size={12} className="text-faint" />
                {trackCount} {trackCount === 1 ? "track" : "tracks"}
              </span>
              {loading && loadInfo && (
                <span className="flex items-center gap-1.5 font-medium" style={{ color: "var(--sp-aqua)" }}>
                  <span className="blink inline-block h-1.5 w-1.5 rounded-full bg-aqua" />
                  {loadInfo.message}
                </span>
              )}
            </div>

            {/* Progress bar while decoding */}
            {loading && loadInfo && (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-surface2">
                  <div
                    className="sheen h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{
                      width: `${Math.min(100, loadInfo.percent)}%`,
                      background:
                        "linear-gradient(90deg, var(--sp-accent), var(--sp-aqua))",
                    }}
                  />
                </div>
                <p className="mt-1.5 text-right text-[11px] font-medium tabular-nums text-faint">
                  {Math.round(loadInfo.percent)}%
                </p>
              </div>
            )}
          </div>

          {!locked && (
            <button
              onClick={onClear}
              className="btn-icon h-8 w-8 flex-none"
              aria-label="Remove file"
              title="Remove file"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </section>
    );
  }

  return null;
}
