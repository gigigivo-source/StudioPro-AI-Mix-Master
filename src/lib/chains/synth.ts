/**
 * Synth chain: Chorus → EQ → Stereo Widener → Reverb.
 * Chorus + widening give pads/synths their airy, wide signature.
 */
import { applyChorus } from "../plugins/chorus";
import { applyDynamicEQ } from "../plugins/dynamicEQ";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { applyStereoWidener } from "../plugins/stereoWidener";
import { applyReverb } from "../plugins/reverb";
import { clonePcm } from "../plugins/_core";
import { genreAmbience } from "./_helpers";
import type { ChainContext, PluginStep } from "./_types";

export function synthChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const dr = Math.max(1, a.dynamicRange);
  const useDynEQ = dr > 14;
  const presence = Math.min(3, 2 + (ctx.settings.intensity / 100) * 1.2);
  const amb = genreAmbience(ctx);
  const decay = Math.min(3.5, 2.0 * amb);
  const wet = Math.min(0.3, 0.2 * amb);

  return [
    {
      name: "Chorus",
      note: "Adding width & movement — 0.5 Hz LFO, ~50% depth",
      params: { rate: 0.5, depth: 0.5, wet: 0.3 },
      apply: (b) => applyChorus(clonePcm(b), 0.5, 0.5, 0.3),
    },
    useDynEQ
      ? {
          name: "Dynamic EQ",
          note: `Wide dynamics (${dr.toFixed(1)} dB) — presence boost only when quiet @ 2.5 kHz`,
          params: { freq: 2500, maxGain: +presence.toFixed(1), threshold: +(a.rms + 3).toFixed(1), q: 1.0 },
          apply: (b) => applyDynamicEQ(clonePcm(b), 2500, presence, a.rms + 3, 1.0),
        }
      : {
          name: "Parametric EQ",
          note: `Presence ${presence.toFixed(1)} dB @ 2.5 kHz for clarity`,
          params: { freq: 2500, gain: +presence.toFixed(1), q: 1.0, type: "bell" },
          apply: (b) => applyParametricEQ(clonePcm(b), 2500, presence, 1.0, "bell"),
        },
    {
      name: "Stereo Widener",
      note: "Widening to 1.3× (lows kept mono so the low end stays solid)",
      params: { width: 1.3 },
      apply: (b) => applyStereoWidener(clonePcm(b), 1.3),
    },
    {
      name: "Reverb",
      note: `Pad space ${decay.toFixed(2)}s · wet ${Math.round(wet * 100)}%`,
      params: { decay: +decay.toFixed(2), wet: +wet.toFixed(2) },
      apply: (b) => applyReverb(clonePcm(b), decay, wet),
    },
  ];
}

export default synthChain;
