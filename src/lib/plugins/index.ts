/**
 * index.ts — exports every plugin in the engine.
 * Each is a pure-ish function: (buffer) => new processed buffer.
 */
export { applyGain } from "./gain";
export { applyHighpass } from "./highpass";
export { applyLowpass } from "./lowpass";
export { applyParametricEQ, type EqType } from "./parametricEQ";
export { applyDynamicEQ } from "./dynamicEQ";
export { applyCompressor, type CompressorParams } from "./compressor";
export {
  applyMultibandCompressor,
  type MultibandCompressorParams,
  type BandParams,
} from "./multibandCompressor";
export { applyDeesser } from "./deesser";
export { applyTransientShaper } from "./transientShaper";
export { applySaturation, type SaturationType } from "./saturation";
export { applyStereoWidener } from "./stereoWidener";
export { applyReverb } from "./reverb";
export { applyDelay } from "./delay";
export { applyGate } from "./gate";
export { applyLimiter } from "./limiter";
export { applySubHarmonic } from "./subHarmonic";
export { applyChorus } from "./chorus";

// Shared core helpers re-exported for consumers that compose chains.
export * from "./_core";
