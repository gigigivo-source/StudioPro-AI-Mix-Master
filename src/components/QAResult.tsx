"use client";

import { AlertTriangle, BadgeCheck, XCircle } from "lucide-react";
import type { QaResult } from "@/lib/audio-processors";

export function QAResult({ qa, attempts }: { qa: QaResult; attempts: number }) {
  const color = qa.passed ? "var(--sp-ok)" : "var(--sp-err)";
  const Icon = qa.passed ? BadgeCheck : XCircle;

  return (
    <section className="glass fade-up overflow-hidden rounded-3xl p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 flex-none items-center justify-center rounded-xl"
          style={{ background: qa.passed ? "rgba(52,225,176,0.14)" : "rgba(255,107,107,0.14)", color }}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold tracking-tight text-ink">
            {qa.passed ? "Quality check passed" : "Quality check needs attention"}
          </h2>
          <p className="text-[12px] font-medium text-mut">
            Broadcast-ready loudness, true peak, width &amp; dynamics verified
            {attempts > 0 ? ` · auto-reprocessed (${attempts}×)` : ""}
          </p>
        </div>
      </div>

      {qa.warnings.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 flex-none" style={{ color: "var(--sp-warn)" }} />
          <p className="text-[12px] font-medium leading-relaxed" style={{ color: "var(--sp-mut)" }}>
            {qa.warnings.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(". ")}.
          </p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {qa.metrics.map((m) => (
          <div key={m.name} className="rounded-2xl border border-line bg-surface p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">{m.name}</p>
            <p
              className="mt-1 font-display text-lg font-bold tabular-nums"
              style={{ color: m.pass ? "var(--sp-ink)" : m.fatal ? "var(--sp-err)" : "var(--sp-warn)" }}
            >
              {m.value}
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-[10.5px] font-medium text-faint">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: m.pass ? "var(--sp-ok)" : m.fatal ? "var(--sp-err)" : "var(--sp-warn)" }}
              />
              expected {m.expected}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
