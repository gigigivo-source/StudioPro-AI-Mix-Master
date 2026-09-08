/**
 * Generic "other" chain: EQ (high-pass + presence) → Compressor → Saturation.
 * For any stem whose category we can't confidently name.
 */
import { applyHighpass } from "../plugins/highpass";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { applyCompressor } from "../plugins/compressor";
import { applySaturation } from "../plugins/saturation";
import { clonePcm } from "../plugins/_core";
import type { ChainContext, PluginStep } from "./_types";

export function otherChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const th = Math.max(-55, Math.min(0, a.rms - 8));
  const presence = Math.min(3.5, 2 + (ctx.settings.intensity / 100) * 1.5);
  const tape = Math.min(0.25, 0.15 + (ctx.settings.intensity / 100) * 0.1);

  return [
    {
      name: "High-pass",
      note: "Clearing rumble/mud below 80 Hz",
      params: { freq: 80, q: 0.707 },
      apply: (b) => applyHighpass(clonePcm(b), 80, 0.707),
    },
    {
      name: "Parametric EQ",
      note: `Gentle presence ${presence.toFixed(1)} dB @ 4 kHz`,
      params: { freq: 4000, gain: +presence.toFixed(1), q: 1.0, type: "bell" },
      apply: (b) => applyParametricEQ(clonePcm(b), 4000, presence, 1.0, "bell"),
    },
    {
      name: "Compressor",
      note: `2:1 smoothing, 15 ms attack — threshold RMS−8`,
      params: { threshold: +th.toFixed(1), ratio: 2, attack: 0.015, release: 0.08, knee: 6 },
      apply: (b) => applyCompressor(clonePcm(b), th, 2, 0.015, 0.08, 6),
    },
    {
      name: "Tape Saturation",
      note: `Tape colour ${Math.round(tape * 100)}% for cohesion`,
      params: { amount: +tape.toFixed(2), type: "tape" },
      apply: (b) => applySaturation(clonePcm(b), tape, "tape"),
    },
  ];
}

export default otherChain;
