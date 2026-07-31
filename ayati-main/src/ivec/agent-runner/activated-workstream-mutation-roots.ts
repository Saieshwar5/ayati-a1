import { isAbsolute } from "node:path";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";

/**
 * Converts authoritative activated-workstream bindings into the filesystem
 * roots usable by focused mutation tools. Routing selections ground
 * activation; they do not make the model maintain a second permission list.
 */
export function deriveActivatedWorkstreamMutationRoots(input: {
  context: ContextEngineMachineContext;
  workstreamId: string;
}): string[] {
  const workstream = input.context.workstream;
  if (!workstream || workstream.workstreamId !== input.workstreamId) return [];

  return [...new Set(workstream.resources.flatMap((binding) => {
    if (
      binding.access !== "mutate"
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
