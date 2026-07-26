import type { CapabilityCatalog } from "./catalog.js";

export function recommendNextCapabilities(input: {
  catalog: CapabilityCatalog;
  activeCapabilities: string[];
  lastActionFailed: boolean;
  availableCapabilities: ReadonlySet<string>;
  limit?: number;
}): string[] {
  const recommendations: string[] = [];
  for (const capabilityId of input.activeCapabilities) {
    const definition = input.catalog.get(capabilityId);
    const next = input.lastActionFailed
      ? definition?.suggestedNext?.failure
      : definition?.suggestedNext?.success;
    for (const candidate of next ?? []) {
      if (input.availableCapabilities.has(candidate) && !recommendations.includes(candidate)) {
        recommendations.push(candidate);
      }
    }
  }
  return recommendations.slice(0, Math.max(0, input.limit ?? 4));
}
