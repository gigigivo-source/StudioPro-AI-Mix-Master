"use client";

import { useState, useRef, useEffect } from "react";
import { AudioWaveform, Moon, Palette, ShieldCheck, Sun, Check } from "lucide-react";
import { ACCENT_OPTIONS } from "@/hooks/useTheme";
import type { AccentColor, Theme } from "@/lib/types";

export function Header({
  theme,
  onToggleTheme,
  accent,
  onSelectAccent,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  accent: AccentColor;
  onSelectAccent: (accent: AccentColor) => void;
}) {
  const [accentOpen, setAccentOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAccentOpen(false);
      }
    };
    if (accentOpen) {
      document.addEventListener("mousedown", onOutside);
    }
    return () => document.removeEventListener("mousedown", onOutside);
  }, [accentOpen]);

  return (
    <header
      className="glass-strong sticky top-0 z-40 border-x-0 border-t-0"
      style={{ borderBottom: "1px solid var(--sp-line)" }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white transition-all duration-300"
            style={{
              background:
                "linear-gradient(135deg, var(--sp-accent) 0%, var(--sp-aqua) 120%)",
              boxShadow: "0 8px 24px -8px var(--sp-glow), 0 0 18px -6px var(--sp-glow-aqua)",
            }}
          >
            <AudioWaveform size={21} strokeWidth={2.1} />
          </span>
          <div className="leading-tight">
            <p className="font-display text-lg font-bold tracking-tight text-ink">
              Studio<span className="text-gradient">Pro</span>
            </p>
            <p className="text-[10px] sm:text-[11px] font-medium tracking-wide text-faint">
              AI MIX &amp; MASTER
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-mut md:inline-flex">
            <ShieldCheck size={13} style={{ color: "var(--sp-ok)" }} />
            100% in-browser · audio never leaves your device
          </span>

          {/* Accent Color Picker */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setAccentOpen((o) => !o)}
              className="btn-icon h-10 w-10 rounded-xl border border-line bg-surface"
              aria-label="Theme accent color"
              title="Change studio accent color"
              aria-expanded={accentOpen}
            >
              <Palette size={17} style={{ color: "var(--sp-accent)" }} />
            </button>

            {accentOpen && (
              <div className="toast-in absolute right-0 top-12 z-50 w-48 rounded-2xl border border-line-strong bg-surface2 p-2 shadow-2xl backdrop-blur-2xl">
                <p className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-faint">
                  Accent Theme
                </p>
                <div className="space-y-1">
                  {ACCENT_OPTIONS.map((opt) => {
                    const selected = accent === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => {
                          onSelectAccent(opt.id);
                          setAccentOpen(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium transition-colors ${
                          selected
                            ? "bg-surface3 text-ink font-semibold"
                            : "text-mut hover:bg-surface hover:text-ink"
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className="h-3.5 w-3.5 rounded-full shadow-sm"
                            style={{ background: opt.bg }}
                          />
                          {opt.label}
                        </span>
                        {selected && (
                          <Check size={14} style={{ color: "var(--sp-aqua)" }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Light / Dark Mode Toggle */}
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
