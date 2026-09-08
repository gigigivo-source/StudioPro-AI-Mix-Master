"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Braces,
  Check,
  ChevronDown,
  Gauge,
  Layers,
  ScrollText,
  Sparkles,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { AUTO_STAGE_LABELS } from "@/lib/plugin-orchestrator";
import type { SessionAuto, SessionStep } from "@/lib/types";

/* ------------------------------------------------------------------ */

function fmtParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null) return `${k}={${JSON.stringify(v)}}`;
      return `${k}=${typeof v === "boolean" ? v : v}`;
    })
    .join("  ");
}

function chainArrow(steps: SessionStep[]): string {
  return steps.map((s) => s.name).join(" → ");
}

function StepBadge({ passed }: { passed: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold"
      style={{
        background: passed ? "rgba(52,225,176,0.12)" : "rgba(255,86,120,0.12)",
        color: passed ? "var(--sp-ok)" : "#ff7b94",
        border: `1px solid ${passed ? "rgba(52,225,176,0.35)" : "rgba(255,86,120,0.35)"}`,
      }}
    >
      {passed ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
      {passed ? "QA Passed" : "QA Warning"}
    </span>
  );
}

function Metric({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-faint">
        <Icon size={12} />
        {label}
      </div>
      <p className="mt-1 font-display text-lg font-bold tabular-nums" style={{ color: tone }}>
        {value}
      </p>
    </div>
  );
}

export function AutoEnginePanel({ auto }: { auto: SessionAuto }) {
  const [openStem, setOpenStem] = useState<string | null>(auto.stems[0]?.name ?? null);

  const logLines = useMemo(() => {
    const lines: string[] = [];
    for (const stem of auto.stems) {
      lines.push(`[STEM] ${stem.name}  ->  ${stem.chainLabel} (${stem.categoryLabel})`);
      for (const s of stem.steps) {
        const p = fmtParams(s.params);
        lines.push(`   ${s.order}. ${s.name}${p ? `  { ${p} }` : ""}${s.note ? `  — ${s.note}` : ""}`);
      }
      lines.push("");
    }
    lines.push("[MASTER BUS]");
    for (const s of auto.masterSteps) {
      const p = fmtParams(s.params);
      lines.push(`   ${s.order}. ${s.name}${p ? `  { ${p} }` : ""}${s.note ? `  — ${s.note}` : ""}`);
    }
    lines.push("");
    for (const attempt of auto.attempts) {
      lines.push(
        `[QA attempt ${attempt.attempt}] passed=${attempt.passed}  lufs=${attempt.lufs.toFixed(1)}  tp=${attempt.truePeakDb.toFixed(2)}dBTP  corr=${attempt.correlation.toFixed(2)}` +
          (attempt.failures.length ? `  fails: ${attempt.failures.join("; ")}` : "")
      );
    }
    return lines;
  }, [auto]);

  const qa = auto.qa;
  const attempted = auto.attempts.length > 1;
  const tonalTone = "var(--sp-accent)";
  const aquaTone = "var(--sp-aqua)";
  const mutTone = "var(--sp-mut)";

  return (
    <div className="glass fade-up space-y-5 rounded-3xl p-5 sm:p-6" style={{ animationDelay: "240ms" }}>
      {/* ---------- Header ---------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-xl"
            style={{ background: "linear-gradient(135deg,var(--sp-accent),var(--sp-aqua))" }}
          >
            <Sparkles size={15} className="text-white" />
          </span>
          <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-ink">
            Automatic Plugin Engine
          </h2>
        </div>
        <StepBadge passed={qa.passed} />
      </div>

      {/* ---------- QA card ---------- */}
      <div className="rounded-2xl border border-line bg-surface/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
            Quality Assurance
            <span className="ml-2 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-mut">
              attempt {qa.attempt}/{Math.max(qa.attempt, 3)}
            </span>
            {attempted && (
              <span className="ml-2 text-[10px] font-semibold" style={{ color: "var(--sp-aqua)" }}>
                auto-reprocessed ✓
              </span>
            )}
          </p>
          {qa.failures.length > 0 && (
            <p className="text-[11px] font-medium text-faint">{qa.failures.join(" · ")}</p>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Metric icon={Gauge} label="LUFS" value={`${qa.lufs.toFixed(1)}`} tone={tonalTone} />
          <Metric icon={Zap} label="True Peak" value={`${qa.truePeakDb.toFixed(2)} dBTP`} tone={aquaTone} />
          <Metric icon={Activity} label="Dyn. Range" value={`${qa.dynamicRange.toFixed(1)} dB`} tone={mutTone} />
          <Metric icon={Waves} label="Correlation" value={`${qa.correlation.toFixed(2)}`} tone={qa.correlation >= 0.7 ? "var(--sp-ok)" : "#ff7b94"} />
          <Metric icon={BadgeCheck} label="LUFS Δ" value={`±${qa.lufsDelta.toFixed(2)}`} tone={qa.lufsDelta <= 0.5 ? "var(--sp-ok)" : "#ff7b94"} />
        </div>
        {auto.warnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">
            {auto.warnings.join(" ")}
          </div>
        )}
      </div>

      {/* ---------- 10-stage timeline ---------- */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <Layers size={13} className="text-faint" />
          <p className="text-[11px] font-bold uppercase tracking-wider text-faint">Engine Pipeline</p>
        </div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {AUTO_STAGE_LABELS.map((label, i) => (
            <div
              key={label}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5"
            >
              <span
                className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-[9px] font-bold"
                style={{
                  background: "rgba(52,225,176,0.15)",
                  color: "var(--sp-ok)",
                  border: "1px solid rgba(52,225,176,0.4)",
                }}
              >
                <Check size={9} strokeWidth={4} />
              </span>
              <span className="text-[10px] font-medium text-mut">
                {i + 1}. {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Per-stem plugin chains ---------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Braces size={13} className="text-faint" />
            <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
              Per-stem processing ({auto.stems.length})
            </p>
          </div>
          <p className="hidden text-[11px] text-faint sm:block">Click a stem to see each plugin decision</p>
        </div>

        <div className="space-y-2">
          {auto.stems.map((stem) => {
            const open = openStem === stem.name;
            return (
              <div key={stem.name} className="overflow-hidden rounded-xl border border-line bg-surface/50">
                <button
                  onClick={() => setOpenStem(open ? null : stem.name)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                >
                  <span
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-[10px] font-bold text-white"
                    style={{ background: "linear-gradient(135deg,var(--sp-accent),#8a5cff)" }}
                  >
                    {stem.categoryLabel[0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-ink">{stem.name}</p>
                    <p className="truncate text-[11px] font-medium" style={{ color: "var(--sp-aqua)" }}>
                      {chainArrow(stem.steps)}
                    </p>
                  </div>
                  <span className="flex-none rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-mut">
                    {stem.categoryLabel} · {stem.steps.length} fx
                  </span>
                  <ChevronDown
                    size={15}
                    className={`flex-none text-faint transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </button>
                {open && (
                  <ol className="border-t border-line px-3 py-2">
                    {stem.steps.map((s) => (
                      <li key={s.order} className="flex gap-2 py-1 text-[12px]">
                        <span className="flex-none font-bold tabular-nums text-faint">{s.order}.</span>
                        <div className="min-w-0">
                          <span className="font-semibold text-ink">{s.name}</span>
                          {s.note && <p className="text-[11px] text-mut">{s.note}</p>}
                          {Object.keys(s.params).length > 0 && (
                            <code className="mt-0.5 block rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">
                              {fmtParams(s.params)}
                            </code>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------- Decision log ---------- */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <ScrollText size={13} className="text-faint" />
          <p className="text-[11px] font-bold uppercase tracking-wider text-faint">Decision Log</p>
          <span className="ml-auto rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-mut">
            {auto.stems.reduce((a, s) => a + s.steps.length, 0) + auto.masterSteps.length} plugins · {auto.bpm} BPM
          </span>
        </div>
        <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-[var(--sp-surface-2)] p-3 font-mono text-[10.5px] leading-relaxed text-mut">
          {logLines.join("\n")}
        </pre>
      </div>
    </div>
  );
}
