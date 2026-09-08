/**
 * chains/index.ts — the pre-defined instrument chains and the registry that
 * resolves a detected stem category to its chain.
 */
import type { StemCategory } from "../plugin-analysis";
import { vocalChain } from "./vocal";
import { drumsChain } from "./drums";
import { bassChain } from "./bass";
import { synthChain } from "./synth";
import { guitarChain } from "./guitar";
import { otherChain } from "./other";
import type { Chain, ChainContext, PluginStep } from "./_types";

export type { Chain, ChainContext, PluginStep, StemAnalysis } from "./_types";
export { vocalChain } from "./vocal";
export { drumsChain } from "./drums";
export { bassChain } from "./bass";
export { synthChain } from "./synth";
export { guitarChain } from "./guitar";
export { otherChain } from "./other";

/** category → chain builder. */
export const CHAINS: Record<StemCategory, Chain> = {
  vocal: vocalChain,
  drums: drumsChain,
  bass: bassChain,
  synth: synthChain,
  guitar: guitarChain,
  other: otherChain,
};

export const CATEGORY_LABELS: Record<StemCategory, string> = {
  vocal: "Vocals",
  drums: "Drums",
  bass: "Bass",
  synth: "Synths / Keys",
  guitar: "Guitar",
  other: "Other",
};

export function chainStepsFor(
  category: StemCategory,
  ctx: ChainContext
): PluginStep[] {
  return CHAINS[category](ctx);
}
