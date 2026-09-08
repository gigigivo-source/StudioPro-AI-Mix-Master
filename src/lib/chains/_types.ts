/**
 * Shared types for the instrument chains.
 */
import type { PcmData } from "../client-audio-engine";
import type { StemCategory } from "../plugin-analysis";

export interface StemAnalysis {
  category: StemCategory;
  /** dBFS */
  rms: number;
  peak: number;
  lufs: number;
  dynamicRange: number;
  correlation: number;
  transientDensity: number;
  spectrum: Float32Array;
}

export interface AutoSettings {
  genre: string;
  loudness: string;
  intensity: number; // 0..100
  vocalFocus: boolean;
  targetLufs: number;
}

export interface ChainContext {
  analysis: StemAnalysis;
  settings: AutoSettings;
  bpm: number;
}

export type ParamValue =
  | number
  | string
  | boolean
  | ParamValue[]
  | { [key: string]: ParamValue };

export interface PluginStep {
  /** Human name, e.g. "De-esser". */
  name: string;
  /** Raw decision parameters for logging. */
  params: Record<string, ParamValue>;
  /** What the "smart brain" decided / why. */
  note: string;
  /** Actually applies the plugin to the running buffer. */
  apply: (buffer: PcmData) => PcmData;
}

export type Chain = (ctx: ChainContext) => PluginStep[];
