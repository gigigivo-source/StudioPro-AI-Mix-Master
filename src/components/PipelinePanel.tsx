"use client";

import { BadgeCheck, Check } from "lucide-react";
import { EqualizerBars } from "@/components/ui/EqualizerBars";
import { formatEta } from "@/lib/format";
import { PIPELINE_STAGES, type PipelineLog, type StageStatus } from "@/lib/audio-processors";

const LEVEL_COLOR: Record<PipelineLog["level"], string> = {
  info: "var(--sp-mut)",
  ok: "var(--sp-ok)",
  warn: "var(--sp-warn)",
  error: "var(--sp-err)",
};

export function PipelinePanel({
  pipeline,
  eta,
}: {
  pipeline: {
    progress: number;
    active: number;
    status: string;
    stages: StageStatus[];
    logs: PipelineLog[];
  };
  eta: number | null;
}) {
  const activeMeta = PIPELINE_STAGES[pipeline.active] ?? PIPELINE_STAGES[0];
  const activeNote =
    pipeline.stages.find((s) => s.id === pipeline.active)?.note ?? pipeline.status;

  return (
    <section className="glass fade-up rounded-3xl p-5 sm:p-6" aria-busy>
      {/* ---------------- Header + big progress ---------------- */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-gradient font-display text-4xl font-bold tabular-nums tracking-tight">
            {Math.round(pipeline.progress)}
            <span className="text-xl">%</span>
          </span>
          <EqualizerBars className="h-7" />
        </div>
        <p className="flex items-center gap-1.5 text-sm font-medium tabular-nums text-mut">
          <BadgeCheck size={14} className="text-faint" />
          {eta != null ? formatEta(eta) : "Working…"}
        </p>
      </div>

      {/* ---------------- Stage timeline ---------------- */}
      <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {PIPELINE_STAGES.map((s) => {
          const state = pipeline.stages.find((x) => x.id === s.id)?.state ?? "pending";
          const active = state === "active";
          const done = state === "done";
          return (
            <li
              key={s.id}
              className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 ${
                active ? "breathe border-transparent ring-accent" : "border-line bg-surface"
              }`}
              style={{
                background: active
                  ? "linear-gradient(135deg, rgba(108,99,255,0.22), rgba(0,212,255,0.14))"
                  : done
                    ? "rgba(52,225,176,0.08)"
                    : undefined,
                opacity: done || active ? 1 : 0.55,
              }}
            >
              <span
                className="flex h-6 w-6 flex-none items-center justify-center rounded-lg text-[12px]"
                style={{
                  background: done ? "rgba(52,225,176,0.18)" : active ? "var(--sp-surface-2)" : "var(--sp-surface-2)",
                  color: done ? "var(--sp-ok)" : active ? "#fff" : "var(--sp-faint)",
                }}
              >
                {done ? <Check size={13} strokeWidth={3} /> : <span aria-hidden>{s.tag}</span>}
              </span>
              <span className="min-w-0">
                <span
                  className="block truncate text-[11px] font-semibold leading-tight"
                  style={{ color: done || active ? "var(--sp-ink)" : "var(--sp-mut)" }}
                >
                  {s.name}
                </span>
                {s.id === 0 && active && (
                  <span className="block text-[9.5px] font-medium text-faint">{pipeline.status}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ---------------- Progress bar ---------------- */}
      <div className="mt-5 h-3 overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-out ${pipeline.progress < 100 ? "sheen" : ""}`}
          style={{
            width: `${Math.min(100, pipeline.progress)}%`,
            background: "linear-gradient(90deg, var(--sp-accent), #8a5cff 55%, var(--sp-aqua))",
            boxShadow: "0 0 18px -2px var(--sp-glow)",
          }}
        />
      </div>

      {/* ---------------- Active status ---------------- */}
      <p
        className="mt-3 flex items-center gap-2 text-[13px] font-medium text-mut"
        aria-live="polite"
        key={activeNote}
      >
        <span
          className="blink inline-block h-2 w-2 flex-none rounded-full"
          style={{ background: "var(--sp-aqua)" }}
        />
        <span className="fade-up">
          <span className="font-semibold text-ink">{activeMeta.name}</span> — {activeNote || "working…"}
        </span>
      </p>

      {/* ---------------- Decision log console ---------------- */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-[#0c0e1e]/70">
        <div className="flex items-center justify-between border-b border-line/70 px-4 py-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            Stage console
          </span>
          <span className="rounded-full bg-surface2 px-2 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-faint">
            {pipeline.logs.length} decisions
          </span>
        </div>
        <ul className="scrollbar-thin max-h-56 space-y-1 overflow-y-auto px-4 py-3">
          {pipeline.logs.length === 0 && (
            <li className="font-mono text-[11px] text-faint">Waiting for the pipeline to start…</li>
          )}
          {pipeline.logs.map((l) => (
            <li
              key={l.id}
              className="fade-up font-mono text-[11px] leading-relaxed"
              style={{ color: LEVEL_COLOR[l.level] ?? "var(--sp-mut)" }}
            >
              <span className="opacity-60">▸</span> {l.text}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
