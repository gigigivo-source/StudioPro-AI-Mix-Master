/**
 * Guitar chain: Compressor → EQ → Delay → Reverb.
 * Gentle 2:1 glue first, presence lift, then rhythm delay + ambience.
 */
import { applyCompressor } from "../plugins/compressor";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { applyDelay } from "../plugins/delay";
import { applyReverb } from "../plugins/reverb";
import { clonePcm } from "../plugins/_core";
import { genreAmbience, noteDur } from "./_helpers";
import type { ChainContext, PluginStep } from "./_types";

export function guitarChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const th = Math.max(-55, Math.min(0, a.rms - 8));
  const clarity = Math.min(4, 2.5 + (ctx.settings.intensity / 100) * 1.5);
  const amb = genreAmbience(ctx);
  const eNote = noteDur(ctx.bpm, 0.125);
  const delayWet = Math.min(0.16, 0.1 * amb);
  const decay = Math.min(2.6, 1.2 * amb);
  const wet = Math.min(0.2, 0.15 * amb);

  return [
    {
      name: "Compressor",
      note: `Evening out with 2:1, slow 20 ms attack so the pick attack survives`,
      params: { threshold: +th.toFixed(1), ratio: 2, attack: 0.02, release: 0.1, knee: 6 },
      apply: (b) => applyCompressor(clonePcm(b), th, 2, 0.02, 0.1, 6),
    },
    {
      name: "Parametric EQ",
      note: `Clarity ${clarity.toFixed(1)} dB @ 3 kHz`,
      params: { freq: 3000, gain: +clarity.toFixed(1), q: 1.0, type: "bell" },
      apply: (b) => applyParametricEQ(clonePcm(b), 3000, clarity, 1.0, "bell"),
    },
    {
      name: "Delay",
      note: `Eighth-note echo @ ${ctx.bpm} BPM (${eNote.toFixed(3)}s) · feedback 15%`,
      params: { time: +eNote.toFixed(3), feedback: 0.15, wet: +delayWet.toFixed(2) },
      apply: (b) => applyDelay(clonePcm(b), eNote, 0.15, delayWet),
    },
    {
      name: "Reverb",
      note: `Space ${decay.toFixed(2)}s · wet ${Math.round(wet * 100)}%`,
      params: { decay: +decay.toFixed(2), wet: +wet.toFixed(2) },
      apply: (b) => applyReverb(clonePcm(b), decay, wet),
    },
  ];
}

export default guitarChain;
