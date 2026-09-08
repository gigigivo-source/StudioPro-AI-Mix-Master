"use client";

import { AudioWaveform, Moon, ShieldCheck, Sun } from "lucide-react";
import type { Theme } from "@/lib/types";

export function Header({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <header
      className="glass-strong sticky top-0 z-40 border-x-0 border-t-0"
      style={{ borderBottom: "1px solid var(--sp-line)" }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
            style={{
              background:
                "linear-gradient(135deg, var(--sp-accent) 0%, #8a5cff 55%, var(--sp-aqua) 120%)",
              boxShadow: "0 8px 24px -8px var(--sp-glow), 0 0 18px -6px var(--sp-glow-aqua)",
            }}
          >
            <AudioWaveform size={21} strokeWidth={2.1} />
          </span>
          <div className="leading-tight">
            <p className="font-display text-lg font-bold tracking-tight text-ink">
              Studio<span className="text-gradient">Pro</span>
            </p>
            <p className="text-[11px] font-medium tracking-wide text-faint">
              AI MIX &amp; MASTER
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-mut sm:inline-flex">
            <ShieldCheck size={13} style={{ color: "var(--sp-ok)" }} />
            100% in-browser · audio never leaves your device
          </span>
          <button
            onClick={onToggleTheme}
            className="btn-icon h-10 w-10 rounded-xl border border-line bg-surface"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? (
              <Sun size={17} className="transition-transform duration-300 hover:rotate-45" />
            ) : (
              <Moon size={17} className="transition-transform duration-300 hover:-rotate-12" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
