/**
 * Drum chain: Gate → Transient Shaper → Compressor → EQ.
 * Punch via the transient shaper, tightness via the gate + 4:1 compressor.
 */
import { applyCompressor } from "../plugins/compressor";
import { applyParametricEQ } from "../plugins/parametricEQ";
import { applyTransientShaper } from "../plugins/transientShaper";
import { applyGate } from "../plugins/gate";
import { clonePcm } from "../plugins/_core";
import { genreAmbience } from "./_helpers";
import type { ChainContext, PluginStep } from "./_types";

/** Map a "transient designer" percentage (0..1) to our ratio (1 = neutral). */
const ratioFromPct = (p: number): number =>
  p <= 0.5 ? p / 0.5 : 1 + (p - 0.5) * 2.4;

export function drumsChain(ctx: ChainContext): PluginStep[] {
  const a = ctx.analysis;
  const th = Math.max(-55, Math.min(0, a.rms - 5));
  const transientDensity = a.transientDensity;
  const punchy = transientDensity > 2.5;

  // Attack/sustain decided from the measured transient density.
  const attackRatio = punchy ? ratioFromPct(0.6) : ratioFromPct(0.85);
  const sustainRatio = punchy ? ratioFromPct(0.4) : ratioFromPct(0.55);

  const amb = genreAmbience(ctx);

  const steps: PluginStep[] = [];

  // 1. Gate — only when there is meaningful low-level noise floor.
  const floor = a.rms; // stem floor ≈ quiet; gate catches ringing below it
  steps.push({
    name: "Gate",
    note: `Transient density ${transientDensity.toFixed(1)}% → gate at ${(floor - 12).toFixed(0)} dB to silence bleed/noise`,
    params: { threshold: Math.round(floor - 12), attack: 0.001, release: 0.05 },
    apply: (b) => applyGate(clonePcm(b), Math.max(-70, floor - 12), 0.001, 0.05),
  });

  // 2. Transient shaper for punch.
  steps.push({
    name: "Transient Shaper",
    note: punchy
      ? `Dense transients — shaping attack ${(attackRatio).toFixed(2)} / sustain ${(sustainRatio).toFixed(2)} for controlled punch`
      : `Sparse hits — adding attack to ${(attackRatio).toFixed(2)} for definition`,
    params: {
      attackPct: Math.round((attackRatio <= 1 ? attackRatio * 50 : (attackRatio - 1) / 2.4 * 50 + 50)),
      sustainPct: Math.round(sustainRatio <= 1 ? sustainRatio * 50 : (sustainRatio - 1) / 2.4 * 50 + 50),
    },
    apply: (b) => applyTransientShaper(clonePcm(b), attackRatio, sustainRatio),
  });

  // 3. Compressor — 4:1 for a glued, consistent kit.
  steps.push({
    name: "Compressor",
    note: `Kit dynamics ${a.dynamicRange.toFixed(1)} dB → 4:1, 10 ms attack for glue without killing the hit`,
    params: { threshold: +th.toFixed(1), ratio: 4, attack: 0.01, release: 0.1, knee: 6 },
    apply: (b) => applyCompressor(clonePcm(b), th, 4, 0.01, 0.1, 6),
  });

  // 4. EQ — kick weight + snap.
  const lowGain = Math.min(5, 3 + (ctx.settings.intensity / 100) * 2);
  const snapGain = Math.min(5, 3.5 + (ctx.settings.intensity / 100) * 1.5);
  steps.push({
    name: "Parametric EQ",
    note: `Kick weight ${lowGain.toFixed(1)} dB @ 60 Hz · snap ${snapGain.toFixed(1)} dB @ 5 kHz`,
    params: { boost60Hz: +lowGain.toFixed(1), boost5kHz: +snapGain.toFixed(1) },
    apply: (b) => {
      let out = applyParametricEQ(clonePcm(b), 60, lowGain, 1.2, "lowshelf");
      out = applyParametricEQ(out, 5000, snapGain, 1.0, "bell");
      return out;
    },
  });

  void amb;
  return steps;
}

export default drumsChain;
