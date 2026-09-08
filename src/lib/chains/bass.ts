/**
 * Bass chain: Multiband Compressor → Saturation → Sub-Harmonic → EQ.
 * The multiband compressor tames the low band hardest so the sub stays round.
 */
import { applyMultibandCompressor } from "../plugins/multibandCompressor";
import { applySaturation } from "../plugins/saturation";
import { applySubHarmonic } from "../plugins/subHarmonic";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { clonePcm } from "../plugins/_core";
import type { ChainContext, PluginStep } from "./_types";

export function bassChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const rms = a.rms;
  // Per-band thresholds derived from the analysed low/mid/high balance.
  const lowTh = Math.max(-70, Math.min(0, rms - 6));
  const midTh = Math.max(-70, Math.min(0, rms - 12));
  const highTh = Math.max(-70, Math.min(0, rms - 16));

  // Sub-boost drive grows with intensity.
  const subAmt = Math.min(0.5, 0.2 + (ctx.settings.intensity / 100) * 0.25);

  const steps: PluginStep[] = [
    {
      name: "Multiband Compressor",
      note: `Band-splitting @200/2000 Hz — low 4:1, mid 2:1, high 1.5:1 to keep the sub solid`,
      params: {
        low: { threshold: +lowTh.toFixed(1), ratio: 4 },
        mid: { threshold: +midTh.toFixed(1), ratio: 2 },
        high: { threshold: +highTh.toFixed(1), ratio: 1.5 },
      },
      apply: (b) =>
        applyMultibandCompressor(clonePcm(b), {
          low: { threshold: lowTh, ratio: 4 },
          mid: { threshold: midTh, ratio: 2 },
          high: { threshold: highTh, ratio: 1.5 },
        }),
    },
    {
      name: "Tube Saturation",
      note: `Warmth ~30% — harmonic colour so the bass cuts through small speakers`,
      params: { amount: 0.3, type: "tube" },
      apply: (b) => applySaturation(clonePcm(b), 0.3, "tube"),
    },
    {
      name: "Sub-Harmonic Synth",
      note: `Extending low end with a ${Math.round(subAmt * 100)}% sub layer @ 55 Hz`,
      params: { freq: 55, amount: +subAmt.toFixed(2) },
      apply: (b) => applySubHarmonic(clonePcm(b), 55, subAmt),
    },
    {
      name: "Parametric EQ",
      note: "Adding +2 dB body @ 80 Hz",
      params: { freq: 80, gain: 2, q: 1.0, type: "lowshelf" },
      apply: (b) => applyParametricEQ(clonePcm(b), 80, 2, 1.0, "lowshelf"),
    },
  ];
  return steps;
}

export default bassChain;
