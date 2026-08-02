import { isAbsolute } from "node:path";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";

/**
 * Converts exact model-selected resource ids into authoritative filesystem
 * roots after activation. The activated projection, not routing output or
 * user-message wording, remains the source of access and availability truth.
 */
export function deriveActivatedWorkstreamMutationRoots(input: {
  context: ContextEngineMachineContext;
  workstreamId: string;
  resourceIds: string[];
}): string[] {
  const workstream = input.context.workstream;
  if (!workstream || workstream.workstreamId !== input.workstreamId) return [];
  const selected = new Set(input.resourceIds);
  if (selected.size === 0) return [];

  return [...new Set(workstream.resources.flatMap((binding) => {
    if (
      !selected.has(binding.resource.resourceId)
      || binding.access !== "mutate"
      || binding.resource.availability === "missing"
      || binding.resource.availability === "deleted"
      || binding.resource.locator.kind !== "filesystem"
      || !isAbsolute(binding.resource.locator.path)
    ) {
      return [];
    }
    return [binding.resource.locator.path];
  }))].sort();
}
