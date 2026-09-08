/**
 * Vocal chain: De-esser → Compressor → EQ → Reverb → Delay.
 * All parameters are derived from the stem's real analysis + genre + intensity.
 */
import { applyCompressor } from "../plugins/compressor";
import { applyDeesser } from "../plugins/deesser";
import { applyDelay } from "../plugins/delay";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { applyReverb } from "../plugins/reverb";
import { clonePcm } from "../plugins/_core";
import { airGain, deEssFreq, genreAmbience, noteDur, presenceGain } from "./_helpers";
import type { ChainContext, PluginStep } from "./_types";

export function vocalChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const n = a.spectrum.length;
  const sib = n > 0 ? Math.max(a.spectrum[n - 4], a.spectrum[n - 5]) : -120;

  // 1. De-esser.
  const deF = deEssFreq(sib);
  const deTh = -20;

  // 2. Compressor — ratio fixed, threshold from RMS.
  const th = Math.max(-55, Math.min(0, a.rms - 6));

  // 3. EQ — presence + air.
  const pg = presenceGain(ctx);
  const ag = airGain(ctx);

  // 4 + 5. Ambience, genre aware.
  const amb = genreAmbience(ctx);
  const decay = Math.min(3.2, 1.5 * amb);
  const wet = Math.min(0.28, 0.15 * amb);
  const qNote = noteDur(ctx.bpm, 0.25);
  const delayWet = Math.min(0.18, 0.1 * amb);

  return [
    {
      name: "De-esser",
      note:
        sib > -70
          ? `Sibilance present (${sib.toFixed(0)} dB @ 8-10k) — cutting at ${deF.toFixed(0)} Hz`
          : "No strong sibilance — engaging gently as a safety net",
      params: { threshold: deTh, freq: Math.round(deF) },
      apply: (b) => applyDeesser(clonePcm(b), deTh, deF),
    },
    {
      name: "Compressor",
      note: `Vocal dynamics ${a.dynamicRange.toFixed(1)} dB → ratio 3:1, threshold RMS−6`,
      params: { threshold: +th.toFixed(1), ratio: 3, attack: 0.005, release: 0.05, knee: 3 },
      apply: (b) => applyCompressor(clonePcm(b), th, 3, 0.005, 0.05, 3),
    },
    {
      name: "Parametric EQ",
      note: `Presence ${pg.toFixed(1)} dB @ 4 kHz · air ${ag.toFixed(1)} dB @ 12 kHz`,
      params: {
        presenceFreq: 4000,
        presenceGain: +pg.toFixed(1),
        airFreq: 12000,
        airGain: +ag.toFixed(1),
      },
      apply: (b) => {
        let out = applyParametricEQ(clonePcm(b), 4000, pg, 1.1, "bell");
        out = applyParametricEQ(out, 12000, ag, 1.0, "bell");
        return out;
      },
    },
    {
      name: "Reverb",
      note: `Room tail ${decay.toFixed(2)}s · wet ${Math.round(wet * 100)}%`,
      params: { decay: +decay.toFixed(2), wet: +wet.toFixed(2) },
      apply: (b) => applyReverb(clonePcm(b), decay, wet),
    },
    {
      name: "Delay",
      note: `Quarter-note echo @ ${ctx.bpm} BPM (${qNote.toFixed(2)}s) · feedback 20%`,
      params: { time: +qNote.toFixed(3), feedback: 0.2, wet: +delayWet.toFixed(2) },
      apply: (b) => applyDelay(clonePcm(b), qNote, 0.2, delayWet),
    },
  ];
}

export default vocalChain;
