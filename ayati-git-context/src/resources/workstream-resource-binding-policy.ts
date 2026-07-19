import type { ResourceId, ResourceRole } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";

export interface WorkstreamResourceBindingInput {
  resourceId: ResourceId;
  role: ResourceRole;
  access: "read" | "mutate";
  primary?: boolean;
}

export interface CanonicalWorkstreamResourceBindingInput {
  resourceId: ResourceId;
  role: ResourceRole;
  access: "read" | "mutate";
  primary: boolean;
  requestRoles: ResourceRole[];
}

export function canonicalizeWorkstreamResourceBindings(
  bindings: WorkstreamResourceBindingInput[],
): CanonicalWorkstreamResourceBindingInput[] {
  const byResource = new Map<ResourceId, CanonicalWorkstreamResourceBindingInput>();
  for (const binding of bindings) {
    const existing = byResource.get(binding.resourceId);
    if (!existing) {
      byResource.set(binding.resourceId, {
        resourceId: binding.resourceId,
        role: binding.role,
        access: binding.access,
        primary: binding.primary === true,
        requestRoles: [binding.role],
      });
      continue;
    }
    if (binding.primary && !existing.primary) {
      existing.role = binding.role;
      existing.primary = true;
    }
    if (binding.access === "mutate") existing.access = "mutate";
    if (!existing.requestRoles.includes(binding.role)) {
      existing.requestRoles.push(binding.role);
    }
  }

  const primaryResourceIds = [...byResource.values()]
    .filter((binding) => binding.primary)
    .map((binding) => binding.resourceId);
  if (primaryResourceIds.length > 1) {
    throw new GitContextServiceError({
      code: "RESOURCE_BINDING_INVALID",
      message: "A workstream may have only one primary resource.",
      details: { resourceIds: primaryResourceIds },
    });
  }
  return [...byResource.values()];
}
