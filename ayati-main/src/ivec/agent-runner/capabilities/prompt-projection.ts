import type { LoopState } from "../../types.js";
import {
  allowedVirtualModeTransitions,
  type VirtualModeTransitionTarget,
} from "../virtual-mode.js";
import type { CapabilityCatalog } from "./catalog.js";
import { recommendNextCapabilities } from "./recommendations.js";
import type { ModeCapabilityOptions } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { collectWorkstreamRoutingEvidence } from "../workstream-routing-evidence.js";

export function buildCapabilityPromptProjection(input: {
  state: LoopState;
  catalog: CapabilityCatalog;
  registry: ToolRegistry;
  activeCapabilities: string[];
  modeCapabilityOptions: ModeCapabilityOptions;
}): string {
  const workstreamBound = input.state.harnessContext.contextEngine?.current.routing?.status === "bound";
  const allowedModes = allowedVirtualModeTransitions(input.state.virtualMode, {
    workstreamBound,
    routingObserved: collectWorkstreamRoutingEvidence(input.state).observed,
  });
  const availableTools = input.registry.nameSet();
  const cards = input.catalog
    .cardsForModes(allowedModes, availableTools)
    .filter((card) => card.allowedModes.some(
      (mode) => input.modeCapabilityOptions[mode].includes(card.id),
    ));
  const lines = groupCards(cards, allowedModes);
  const availableCapabilities = new Set(cards.map((card) => card.id));
  const latestStep = input.state.completedSteps.at(-1);
  const recommendations = recommendNextCapabilities({
    catalog: input.catalog,
    activeCapabilities: input.activeCapabilities,
    lastActionFailed: latestStep?.outcome === "failed",
    availableCapabilities,
  });

  return [
    "Choose 1-3 exact capability ids for the next mode transition. Capabilities select tools but never grant authority.",
    ...lines,
    ...(input.activeCapabilities.length > 0
      ? [`Active capabilities: ${input.activeCapabilities.join(", ")}.`]
      : []),
    ...(recommendations.length > 0
      ? [`Suggested next capabilities after the latest result: ${recommendations.join(", ")}.`]
      : []),
  ].join("\n");
}

function groupCards(
  cards: ReturnType<CapabilityCatalog["cardsForModes"]>,
  modes: VirtualModeTransitionTarget[],
): string[] {
  const lines: string[] = [];
  for (const mode of modes) {
    const modeCards = cards.filter((card) => card.allowedModes.includes(mode));
    if (modeCards.length === 0) continue;
    lines.push(`${mode}:`);
    for (const card of modeCards) {
      lines.push(`- ${card.id}: ${card.summary} ${card.whenToUse}`);
    }
  }
  return lines;
}
