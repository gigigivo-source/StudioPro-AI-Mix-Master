"use client";

import { BadgeCheck, Check, Settings2, SlidersHorizontal, Timer } from "lucide-react";
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
}: {
  progress: number;
  stage: Stage;
  status: string;
  eta: number | null;
  summary: { genre: string; loudness: string; tracks: number };
}) {
  const stageIndex = STAGE_ORDER.indexOf(stage);

  return (
    <section className="glass fade-up rounded-3xl p-6 sm:p-8" aria-busy>
      {/* ---------------- Stage stepper ---------------- */}
      <div className="flex items-start">
        {STAGES.map((s, i) => {
          const Icon = s.icon;
          const done = i < stageIndex;
          const active = i === stageIndex;
          return (
            <div key={s.id} className="flex flex-1 items-start last:flex-none">
              <div className="flex w-20 flex-col items-center gap-2 sm:w-24">
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-2xl border transition-all duration-300 ${
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
                  className={`text-[11px] font-semibold tracking-wide ${
                    active ? "text-ink" : done ? "text-mut" : "text-faint"
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

      {/* ---------------- Big progress ---------------- */}
      <div className="mt-8 flex items-end justify-between">
        <div className="flex items-center gap-3">
          <span className="text-gradient font-display text-5xl font-bold tabular-nums tracking-tight">
            {Math.round(progress)}
            <span className="text-2xl">%</span>
          </span>
          {stage === "mastering" && <EqualizerBars className="mb-2 h-7" />}
        </div>
        <p className="flex items-center gap-1.5 text-sm font-medium tabular-nums text-mut">
          <Timer size={14} className="text-faint" />
          {eta != null ? formatEta(eta) : "Working…"}
        </p>
      </div>

      <div className="mt-3 h-3.5 overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${
            progress < 100 ? "sheen" : ""
          }`}
          style={{
            width: `${Math.min(100, progress)}%`,
            background:
              "linear-gradient(90deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 100%)",
            boxShadow: "0 0 18px -2px var(--sp-glow)",
          }}
        />
      </div>

      {/* ---------------- Live status ---------------- */}
      <p className="mt-4 flex items-center gap-2 text-sm font-medium text-mut" aria-live="polite">
        <span className="blink inline-block h-2 w-2 flex-none rounded-full" style={{ background: "var(--sp-aqua)" }} />
        <span key={status} className="fade-up">
          {status}
        </span>
      </p>

      {/* ---------------- Session chips ---------------- */}
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
