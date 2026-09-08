"use client";

import { BadgeCheck, Check, Settings2, SlidersHorizontal, Timer, XCircle } from "lucide-react";
import { EqualizerBars } from "@/components/ui/EqualizerBars";
import { formatEta } from "@/lib/format";
import type { Stage } from "@/lib/types";

const STAGES: { id: Stage; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: "mixing", label: "Mixing", icon: SlidersHorizontal },
  { id: "mastering", label: "Mastering", icon: Settings2 },
  { id: "qc", label: "QC", icon: BadgeCheck },
];

const STAGE_ORDER: Stage[] = ["mixing", "mastering", "qc"];

export function ProcessingView({
  progress,
  stage,
  status,
  eta,
  summary,
  onCancel,
}: {
  progress: number;
  stage: Stage;
  status: string;
  eta: number | null;
  summary: { genre: string; loudness: string; tracks: number };
  onCancel?: () => void;
}) {
  const stageIndex = STAGE_ORDER.indexOf(stage);

  return (
    <section className="glass fade-up rounded-3xl p-5 sm:p-7 md:p-8" aria-busy aria-live="polite">
      {/* ---------------- Top bar with Stage Stepper & Cancel ---------------- */}
      <div className="flex items-center justify-between gap-4 pb-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">
          Mastering Pipeline
        </span>

        {onCancel && (
          <button
            onClick={onCancel}
            className="btn-danger px-3 py-1.5 text-xs font-semibold"
            title="Cancel mastering process"
          >
            <XCircle size={14} />
            Cancel
          </button>
        )}
      </div>

      {/* ---------------- Stage stepper ---------------- */}
      <div className="mt-4 flex items-start">
        {STAGES.map((s, i) => {
          const Icon = s.icon;
          const done = i < stageIndex;
          const active = i === stageIndex;
          return (
            <div key={s.id} className="flex flex-1 items-start last:flex-none">
              <div className="flex w-16 sm:w-20 md:w-24 flex-col items-center gap-1.5 sm:gap-2">
                <span
                  className={`flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-2xl border transition-all duration-300 ${
                    active ? "breathe border-transparent" : ""
                  }`}
                  style={{
                    background: active
                      ? "linear-gradient(135deg, var(--sp-accent), var(--sp-aqua))"
                      : done
                        ? "rgba(52, 225, 176, 0.12)"
                        : "var(--sp-surface-2)",
                    borderColor: done ? "rgba(52, 225, 176, 0.4)" : "var(--sp-line)",
                    color: active
                      ? "#fff"
                      : done
                        ? "var(--sp-ok)"
                        : "var(--sp-faint)",
                  }}
                >
                  {done ? <Check size={18} strokeWidth={2.6} /> : <Icon size={18} />}
                </span>
                <span
                  className={`text-[10px] sm:text-[11px] font-semibold tracking-wide ${
                    active ? "text-ink font-bold" : done ? "text-mut" : "text-faint"
                  }`}
                >
                  {s.label}
                </span>
              </div>

              {/* Connector */}
              {i < STAGES.length - 1 && (
                <div className="mt-5 h-0.5 flex-1 overflow-hidden rounded-full bg-surface2">
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{
                      width: done ? "100%" : "0%",
                      background:
                        "linear-gradient(90deg, var(--sp-ok), var(--sp-accent))",
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---------------- Big progress & Estimated Time Remaining ---------------- */}
      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-gradient font-display text-4xl sm:text-5xl font-bold tabular-nums tracking-tight">
            {Math.round(progress)}
            <span className="text-2xl">%</span>
          </span>
          <EqualizerBars className="mb-2 h-7" />
        </div>

        <div className="flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-1.5 text-xs sm:text-sm font-medium tabular-nums text-mut">
          <Timer size={14} className="text-faint" />
          <span className="font-semibold text-ink">{formatEta(eta)}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-3.5 overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            progress < 100 ? "sheen" : ""
          }`}
          style={{
            width: `${Math.min(100, Math.max(2, progress))}%`,
            background:
              "linear-gradient(90deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 100%)",
            boxShadow: "0 0 18px -2px var(--sp-glow)",
          }}
        />
      </div>

      {/* ---------------- Live status message ---------------- */}
      <p className="mt-4 flex items-center gap-2 text-xs sm:text-sm font-medium text-mut" aria-live="polite">
        <span className="blink inline-block h-2 w-2 flex-none rounded-full" style={{ background: "var(--sp-aqua)" }} />
        <span key={status} className="fade-up truncate">
          {status || "Processing audio…"}
        </span>
      </p>

      {/* ---------------- Session summary chips ---------------- */}
      <div className="mt-5 flex flex-wrap gap-2">
        {[
          summary.genre.replace(/_/g, " "),
          `${summary.loudness.replace(/_/g, " ")} target`,
          `${summary.tracks} ${summary.tracks === 1 ? "track" : "tracks"} summed`,
        ].map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-line bg-surface px-3 py-1 text-[11px] font-medium capitalize text-mut"
          >
            {chip}
          </span>
        ))}
      </div>
    </section>
  );
}
