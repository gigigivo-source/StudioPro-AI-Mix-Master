"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CloudUpload,
  FileArchive,
  FolderOpen,
  Layers,
  ShieldCheck,
  Timer,
  X,
  XCircle,
  Gauge,
} from "lucide-react";
import { formatBytes, formatDuration, formatEta, formatSpeed } from "@/lib/format";
import { validateFile, isSupportedAudio, isZipFile } from "@/lib/file-loader";
import type { Phase, Project, UploadProgress } from "@/lib/types";

const ACCEPT =
  ".zip,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff,.aif,.opus,.webm,audio/*,application/zip,application/x-zip-compressed";

export function UploadZone({
  phase,
  project,
  uploadProgress,
  onFileSelected,
  onFilesSelected,
  onCancel,
  onClear,
  onError,
}: {
  phase: Phase;
  project: Project | null;
  uploadProgress: UploadProgress | null;
  onFileSelected: (file: File) => void;
  onFilesSelected?: (files: File[]) => void;
  onCancel?: () => void;
  onClear: () => void;
  onError?: (msg: string) => void;
}) {
  const [dragState, setDragState] = useState<"none" | "valid" | "invalid">("none");
  const [droppedSuccess, setDroppedSuccess] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const loading = phase === "loading";
  const locked = phase === "processing" || phase === "done";

  /* Prevent browser from opening files dropped outside */
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (files.length === 0) return;

      if (files.length > 1 && onFilesSelected) {
        onFilesSelected(Array.from(files));
        return;
      }

      const file = files[0];
      const validation = validateFile(file);
      if (!validation.valid) {
        setDragState("invalid");
        onError?.(validation.error || "Unsupported file format.");
        setTimeout(() => setDragState("none"), 2500);
        return;
      }

      setDroppedSuccess(true);
      setTimeout(() => setDroppedSuccess(false), 800);
      onFileSelected(file);
    },
    [onError, onFileSelected, onFilesSelected]
  );

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current++;

    // Check dragged items format if types available
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      let hasInvalid = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const type = item.type.toLowerCase();
          if (
            type &&
            !type.startsWith("audio/") &&
            !type.includes("zip") &&
            !type.includes("octet-stream")
          ) {
            hasInvalid = true;
          }
        }
      }
      setDragState(hasInvalid ? "invalid" : "valid");
    } else {
      setDragState("valid");
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragState("none");
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragState("none");
      if (locked || loading) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    },
    [handleFiles, locked, loading]
  );

  const showEmpty = (phase === "idle" || phase === "batch") && !project && !loading;

  /* ------------------------------------------------ 1. Empty drop zone */
  if (showEmpty) {
    const isInvalid = dragState === "invalid";
    const isValid = dragState === "valid";

    return (
      <section
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`glass relative flex min-h-[300px] flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-12 text-center transition-all duration-300 ${
          isInvalid
            ? "drag-invalid border-err bg-err/5"
            : isValid
              ? "drag-active border-accent scale-[1.01]"
              : droppedSuccess
                ? "drop-success border-ok"
                : "border-line hover:border-line-strong"
        }`}
        aria-label="Audio upload drop zone"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) handleFiles(files);
            e.target.value = "";
          }}
        />

        <span
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl text-white transition-transform duration-300"
          style={{
            background: isInvalid
              ? "var(--sp-err)"
              : "linear-gradient(135deg, var(--sp-accent) 0%, var(--sp-aqua) 125%)",
            boxShadow: isInvalid
              ? "0 14px 40px -10px rgba(255,92,122,0.6)"
              : "0 14px 40px -10px var(--sp-glow), 0 0 30px -8px var(--sp-glow-aqua)",
            transform: isValid ? "scale(1.12) rotate(-4deg)" : undefined,
          }}
        >
          {isInvalid ? (
            <AlertCircle size={30} strokeWidth={2} />
          ) : (
            <CloudUpload size={30} strokeWidth={2} />
          )}
        </span>

        <h2 className="font-display text-xl font-bold tracking-tight text-ink">
          {isInvalid
            ? "Unsupported file type"
            : isValid
              ? "Release to upload stems or tracks"
              : "Drop your audio files or session ZIP here"}
        </h2>

        <p className="mt-2 max-w-md text-xs sm:text-sm leading-relaxed text-mut">
          {isInvalid ? (
            <span className="text-err font-medium">
              Please drop WAV, MP3, FLAC, OGG, M4A, AAC, AIFF, or ZIP session files.
            </span>
          ) : (
            <>
              Master single tracks or full multi-track stems —{" "}
              <span className="font-semibold text-ink">
                WAV · MP3 · FLAC · OGG · M4A · AIFF · ZIP
              </span>
            </>
          )}
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => inputRef.current?.click()}
            className="btn-ghost px-5 py-2.5 text-sm"
          >
            <FolderOpen size={16} style={{ color: "var(--sp-aqua)" }} />
            Browse files
          </button>
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-[11px] font-medium text-faint">
          <ShieldCheck size={13} style={{ color: "var(--sp-ok)" }} />
          Local browser processing · Max file size 1 GB · Audio never leaves your machine
        </p>
      </section>
    );
  }

  /* ------------------------------------------------ 2. Loading / Uploading state */
  if (loading && uploadProgress) {
    const isExtracting = uploadProgress.stage === "extracting";
    const isDecoding = uploadProgress.stage === "decoding";

    return (
      <section className="glass rounded-3xl p-5 sm:p-6 shadow-xl" aria-live="polite">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="flex h-12 w-12 flex-none items-center justify-center rounded-xl animate-pulse"
              style={{
                background:
                  "linear-gradient(135deg, color-mix(in srgb, var(--sp-accent) 30%, transparent), color-mix(in srgb, var(--sp-aqua) 20%, transparent))",
                border: "1px solid var(--sp-line)",
                color: "var(--sp-aqua)",
              }}
            >
              <CloudUpload size={22} className="animate-bounce" />
            </span>

            <div className="min-w-0">
              <p className="font-semibold text-sm text-ink truncate">
                {uploadProgress.message || "Uploading and preparing session…"}
              </p>
              <p className="text-xs text-mut mt-0.5">
                {isExtracting
                  ? "Unpacking ZIP stems into memory…"
                  : isDecoding
                    ? "Decoding PCM audio channels…"
                    : "Reading audio stream…"}
              </p>
            </div>
          </div>

          {onCancel && (
            <button
              onClick={onCancel}
              className="btn-danger px-3 py-1.5 text-xs flex-none"
              title="Cancel upload"
            >
              <XCircle size={14} />
              Cancel
            </button>
          )}
        </div>

        {/* Big Progress Metric Bar */}
        <div className="mt-5 space-y-2">
          <div className="flex items-end justify-between text-xs">
            <span className="font-display text-2xl font-bold tabular-nums text-ink">
              {Math.round(uploadProgress.percent)}
              <span className="text-sm font-semibold text-faint">%</span>
            </span>

            <div className="flex items-center gap-3 text-xs font-medium text-mut">
              {uploadProgress.loaded > 0 && uploadProgress.total > 0 && (
                <span className="tabular-nums">
                  {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
                </span>
              )}

              {uploadProgress.speedMBs > 0 && (
                <span className="flex items-center gap-1 tabular-nums font-semibold" style={{ color: "var(--sp-aqua)" }}>
                  <Gauge size={13} />
                  {formatSpeed(uploadProgress.speedMBs * 1024 * 1024)}
                </span>
              )}

              {uploadProgress.etaSec != null && (
                <span className="flex items-center gap-1 text-faint tabular-nums">
                  <Timer size={13} />
                  {formatEta(uploadProgress.etaSec)}
                </span>
              )}
            </div>
          </div>

          <div className="h-3 overflow-hidden rounded-full bg-surface2">
            <div
              className="sheen h-full rounded-full transition-[width] duration-200 ease-out"
              style={{
                width: `${Math.min(100, Math.max(3, uploadProgress.percent))}%`,
                background:
                  "linear-gradient(90deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 100%)",
                boxShadow: "0 0 14px -2px var(--sp-glow)",
              }}
            />
          </div>
        </div>
      </section>
    );
  }

  /* ------------------------------------------------ 3. Loaded project card */
  if (project) {
    const trackCount = project.tracks.length;
    return (
      <section className="glass rounded-3xl p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span
            className="flex h-12 w-12 flex-none items-center justify-center rounded-xl"
            style={{
              background:
                "linear-gradient(135deg, color-mix(in srgb, var(--sp-accent) 25%, transparent), color-mix(in srgb, var(--sp-aqua) 15%, transparent))",
              border: "1px solid var(--sp-line)",
              color: "var(--sp-aqua)",
            }}
          >
            <FileArchive size={22} strokeWidth={2} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-ink" title={project.fileName}>
                {project.fileName}
              </p>
              <span className="flex items-center gap-1 rounded-md bg-ok/10 px-2 py-0.5 text-[10px] font-bold text-ok">
                <CheckCircle2 size={11} /> Ready
              </span>
            </div>

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
            </div>
          </div>

          {!locked && (
            <button
              onClick={onClear}
              className="btn-icon h-8 w-8 flex-none text-mut hover:text-ink"
              aria-label="Remove loaded session"
              title="Remove session and upload new audio"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </section>
    );
  }

  return null;
}
