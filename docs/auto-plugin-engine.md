# Automatic Plugin Engine

StudioPro's "100% decision-making brain". The app analyses every stem, decides
which plugins to use, derives their parameters from the audio itself, applies
them in the correct order, and evaluates the result with QA — **zero plugin
knowledge required from the user.**

Everything runs 100% in the browser on the user's own decoded audio. The DSP
operates on the same `PcmData` (`{ sampleRate, channels: Float32Array[] }`)
representation the rest of the engine uses — the exact live channel data an
`AudioBuffer` exposes through `getChannelData()`, so each plugin is conceptually
*buffer in → processed buffer out* and works identically in the browser and in
Node tests.

## Structure

```
src/lib/plugins/        # 17 DSP plugins (each: process buffer -> buffer)
  _core.ts                shared primitives (biquad/RBJ, envelopes, mid-side, cloning)
  gain, highpass, lowpass, parametricEQ, dynamicEQ,
  compressor, multibandCompressor, deesser, transientShaper,
  saturation, stereoWidener, reverb, delay, gate, limiter,
  subHarmonic, chorus
src/lib/chains/         # pre-defined per-category chains w/ dynamic params
  vocal, drums, bass, synth, guitar, other
  index.ts                category -> chain registry
src/lib/plugin-analysis.ts   # measureRMS/Peak/LUFS/DR/Spectrum/Correlation/TransientDensity + detectCategory
src/lib/plugin-orchestrator.ts # the brain: classify -> analyse -> chain -> mix -> master bus -> QA(reprocess x3)
src/components/AutoEnginePanel.tsx # results UI: QA card, 10-stage timeline, per-stem chains, decision log
src/components/ProcessingView.tsx  # live 10-stage timeline while mastering
```

## Behaviour

- **Category detection** per stem: keyword match on the file name, falling back
  to a spectrum heuristic.
- **Chains** are applied per stem; parameters come from measured RMS, dynamic
  range, spectrum, transient density, genre and intensity.
- **Master bus** = glue compressor → genre EQ → true-peak limiter (+ loudness
  normalisation), all parameterised from the mix.
- **QA** measures LUFS / true peak / correlation after every master. On failure
  it auto-reprocesses (max 3 attempts), adjusting limiter ceiling/gain or
  reducing stereo width, then delivers the best master with a warning.

## Testing

The plugin engine is exercised end-to-end in Node (no browser needed):

```bash
# acceptance smoke test (5 synthetic stems + auto-reprocess probe + 17-plugin sweep)
npx tsx scripts/auto-plugin-smoke.mts
```

Checks: correct chain per category, master LUFS within ±0.5 dB of target,
true peak ≤ −0.2 dBTP, correlation ≥ 0.7, QA auto-reprocess triggers on failure,
all 17 plugins run without producing non-finite samples.

The pre-existing pipeline smoke test still covers the export/mixing path:

```bash
npx tsx scripts/pipeline-smoke.mts
```
