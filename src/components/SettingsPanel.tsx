"use client";

import type { CSSProperties } from "react";
import {
  Apple,
  Disc2,
  Disc3,
  Guitar,
  HandMetal,
  Headphones,
  Info,
  Mic,
  MonitorPlay,
  Music,
  Music2,
  Piano,
  Rocket,
  SlidersHorizontal,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { intensityLabel } from "@/lib/format";
import type { Settings } from "@/lib/types";

interface GenreDef {
  id: string;
  label: string;
  icon: LucideIcon;
  tip: string;
}

const GENRES: GenreDef[] = [
  { id: "POP", label: "Pop", icon: Mic, tip: "Bright, polished, radio-ready balance" },
  { id: "HIP_HOP", label: "Hip-Hop", icon: Headphones, tip: "Heavy sub, tight and punchy low end" },
  { id: "EDM", label: "EDM", icon: Rocket, tip: "Aggressive drive, wide stereo air" },
  { id: "ROCK", label: "Rock", icon: Guitar, tip: "Punchy mids, solid low foundation" },
  { id: "ACOUSTIC", label: "Acoustic", icon: Music, tip: "Warm, natural, restrained processing" },
  { id: "CLASSICAL", label: "Classical", icon: Piano, tip: "Gentle — preserves dynamics and space" },
  { id: "JAZZ", label: "Jazz", icon: Disc2, tip: "Smooth, warm tonal character" },
  { id: "METAL", label: "Metal", icon: HandMetal, tip: "Dense low-mids, high drive and gain" },
  { id: "R_AND_B", label: "R&B", icon: Waves, tip: "Deep bass, silky top end" },
  { id: "LO_FI", label: "Lo-Fi", icon: SlidersHorizontal, tip: "Rolled-off highs, warm saturation" },
];

interface TargetDef {
  id: string;
  label: string;
  lufs: string;
  icon: LucideIcon;
  tip: string;
}

const TARGETS: TargetDef[] = [
  { id: "SPOTIFY", label: "Spotify", lufs: "−14 LUFS", icon: Music2, tip: "Loudness-normalized streaming standard" },
  { id: "APPLE_MUSIC", label: "Apple Music", lufs: "−16 LUFS", icon: Apple, tip: "Apple Music normalization target" },
  { id: "YOUTUBE", label: "YouTube", lufs: "−14 LUFS", icon: MonitorPlay, tip: "YouTube's recommended loudness" },
  { id: "CD", label: "CD Master", lufs: "−9 LUFS", icon: Disc3, tip: "Traditional optical disc master level" },
];

const SECTION_LABEL =
  "text-[11px] font-bold tracking-[0.14em] text-faint uppercase";

export function SettingsPanel({
  settings,
  onChange,
  onProcess,
  disabled,
  hasProject,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onProcess: () => void;
  disabled: boolean;
  hasProject: boolean;
}) {
  return (
    <section className="glass space-y-6 sm:space-y-7 rounded-3xl p-5 sm:p-6 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-bold tracking-tight text-ink">
          Mastering Profile
        </h2>
        <Tooltip label="These controls drive the on-device mastering chain: genre EQ, bus dynamics, loudness normalization and true-peak limiting.">
          <button className="btn-icon h-7 w-7" aria-label="About settings">
            <Info size={14} />
          </button>
        </Tooltip>
      </div>

      {/* ---------------- Genre ---------------- */}
      <div>
        <p className={`${SECTION_LABEL} mb-3`}>Genre Target</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Genre">
          {GENRES.map((g) => {
            const Icon = g.icon;
            const selected = settings.genre === g.id;
            return (
              <Tooltip key={g.id} label={g.tip} width={200} fullWidth>
                <button
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onChange({ genre: g.id })}
                  className={`flex w-full flex-col items-center gap-2 rounded-xl border px-2 py-3 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "ring-accent"
                      : "border-line bg-surface hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface2"
                  }`}
                >
                  <Icon
                    size={20}
                    strokeWidth={2}
                    style={{
                      color: selected ? "var(--sp-aqua)" : "var(--sp-mut)",
                      transition: "color .15s ease",
                    }}
                  />
                  <span
                    className="text-xs font-semibold"
                    style={{ color: selected ? "var(--sp-ink)" : "var(--sp-mut)" }}
                  >
                    {g.label}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* ---------------- Loudness target ---------------- */}
      <div>
        <p className={`${SECTION_LABEL} mb-3`}>Loudness Standard</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Loudness target">
          {TARGETS.map((t) => {
            const Icon = t.icon;
            const selected = settings.loudness === t.id;
            return (
              <Tooltip key={t.id} label={t.tip} width={200} fullWidth>
                <button
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => onChange({ loudness: t.id })}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "ring-accent"
                      : "border-line bg-surface hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface2"
                  }`}
                >
                  <span
                    className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-line"
                    style={{
                      background: selected
                        ? "linear-gradient(135deg, color-mix(in srgb, var(--sp-accent) 28%, transparent), color-mix(in srgb, var(--sp-aqua) 16%, transparent))"
                        : "var(--sp-surface-2)",
                      color: selected ? "var(--sp-aqua)" : "var(--sp-mut)",
                    }}
                  >
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px] font-semibold"
                      style={{ color: selected ? "var(--sp-ink)" : "var(--sp-mut)" }}
                    >
                      {t.label}
                    </span>
                    <span className="block text-[11px] font-medium tabular-nums text-faint">
                      {t.lufs}
                    </span>
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* ---------------- Intensity ---------------- */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <p className={`${SECTION_LABEL} flex items-center gap-1.5`}>
            Mastering Intensity
            <Tooltip label="How hard the chain works: 0% is gentle acoustic polish, 100% is heavy analog saturation, multi-band compression and true-peak drive.">
              <button className="btn-icon h-5 w-5" aria-label="About intensity">
                <Info size={12} />
              </button>
            </Tooltip>
          </p>
          <span className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium text-faint">
              {intensityLabel(settings.intensity)}
            </span>
            <span className="text-gradient font-display text-xl font-bold tabular-nums">
              {settings.intensity}%
            </span>
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={settings.intensity}
          disabled={disabled}
          onChange={(e) => onChange({ intensity: Number(e.target.value) })}
          className="sp-range"
          style={{ "--fill": `${settings.intensity}%` } as CSSProperties}
          aria-label="Mastering intensity"
        />
        <div className="mt-2 flex justify-between text-[10px] font-medium tracking-wide text-faint">
          <span>Gentle</span>
          <span>Balanced</span>
          <span>Punchy</span>
          <span>Aggressive</span>
        </div>
      </div>

      {/* ---------------- Vocal focus ---------------- */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4">
        <div>
          <p className="text-[13px] font-semibold text-ink">Vocal Focus Clarity</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mut">
            Lifts presence at 3 kHz and carves competing low-mids so vocals cut
            through cleanly.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.vocalFocus}
          disabled={disabled}
          onClick={() => onChange({ vocalFocus: !settings.vocalFocus })}
          className="sp-switch"
          data-on={settings.vocalFocus}
          style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}
          aria-label="Vocal focus toggle"
        />
      </div>

      {/* ---------------- CTA ---------------- */}
      <div>
        <button
          onClick={onProcess}
          disabled={disabled || !hasProject}
          className="btn-primary h-13 w-full px-6 py-3.5 text-[15px]"
        >
          <SlidersHorizontal size={18} strokeWidth={2.2} />
          Mix &amp; Master
        </button>
        {!hasProject && (
          <p className="mt-2.5 text-center text-[11px] font-medium text-faint">
            Upload a track or session ZIP to unlock the mastering chain
          </p>
        )}
      </div>
    </section>
  );
}
