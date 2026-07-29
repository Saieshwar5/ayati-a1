import {
  isObservationalTool,
} from "../../../skills/tool-taxonomy.js";
import type { WorkstreamBindingCapabilityPolicy } from "../workstream-binding-capability-policy.js";
import {
  isGitContextRoutingToolName,
  isToolAllowedByWorkstreamBinding,
} from "../workstream-binding-capability-policy.js";
import type { VirtualModeTransitionTarget } from "../virtual-mode.js";
import type { CapabilityCatalog } from "./catalog.js";
import type {
  CapabilitySurfaceResult,
  CapabilityUnavailableReason,
  UnavailableCapability,
} from "./contracts.js";
import type { ToolRegistry } from "./registry.js";

export const DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS = 8;
export const PRESSURE_MAX_CAPABILITY_SURFACE_TOOLS = 6;

export interface ResolveCapabilitySurfaceInput {
  catalog: CapabilityCatalog;
  registry: ToolRegistry;
  capabilities: string[];
  mode: VirtualModeTransitionTarget;
  policy: WorkstreamBindingCapabilityPolicy;
  maxVisibleTools?: number;
  contextPressureActive?: boolean;
  allowPartialRegistry?: boolean;
}

export function resolveCapabilitySurface(
  input: ResolveCapabilitySurfaceInput,
): CapabilitySurfaceResult {
  const capabilities = normalizeStrings(input.capabilities);
  const requested = capabilities;
  if (capabilities.length === 0) {
    return emptyResult({
      status: "invalid_request",
      requested,
      message: "A mode transition requires one to three exact capability ids.",
    });
  }

  const maxVisibleTools = resolveToolLimit(input);
  const missing: string[] = [];
  const unavailableCapabilities: UnavailableCapability[] = [];
  const coreTools: string[] = [];
  const optionalTools: string[] = [];
  const coverage: CapabilitySurfaceResult["coverage"] = [];

  for (const capabilityId of capabilities) {
    const definition = input.catalog.get(capabilityId);
    if (!definition) {
      missing.push(capabilityId);
      continue;
    }
    if (!definition.allowedModes.includes(input.mode)) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: "mode_not_allowed",
        tools: [...definition.coreTools],
      });
      continue;
    }
    if (
      definition.authority === "unbound"
      && input.policy.workstreamBound
    ) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: "not_available_after_workstream_binding",
        tools: [...definition.coreTools],
      });
      continue;
    }
    if (
      definition.authority === "bound"
      && !input.policy.workstreamBound
    ) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: "requires_workstream_binding",
        tools: [...definition.coreTools],
      });
      continue;
    }

    const availableCoreTools = definition.coreTools.filter((tool) => input.registry.get(tool));
    const missingCoreTools = definition.coreTools.filter((tool) => !input.registry.get(tool));
    if (
      input.allowPartialRegistry
      && definition.coreTools.length > 0
      && availableCoreTools.length === 0
    ) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: "core_tool_unavailable",
        tools: missingCoreTools,
      });
      continue;
    }
    if (!input.allowPartialRegistry && missingCoreTools.length > 0) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: "core_tool_unavailable",
        tools: missingCoreTools,
      });
      continue;
    }

    const resolvedCoreTools = input.allowPartialRegistry
      ? availableCoreTools
      : definition.coreTools;
    const forbiddenCoreTools = resolvedCoreTools.filter(
      (tool) => !isToolEligibleForMode(input.mode, input.policy, tool),
    );
    if (forbiddenCoreTools.length > 0) {
      unavailableCapabilities.push({
        capability: capabilityId,
        reason: unavailableReason(input.policy, forbiddenCoreTools),
        tools: forbiddenCoreTools,
      });
      continue;
    }

    const eligibleOptionalTools = (definition.optionalTools ?? [])
      .filter((tool) => input.registry.get(tool))
      .filter((tool) => isToolEligibleForMode(input.mode, input.policy, tool));
    coreTools.push(...resolvedCoreTools);
    optionalTools.push(...eligibleOptionalTools);
    coverage.push({
      capability: capabilityId,
      coreTools: [...resolvedCoreTools],
      optionalTools: eligibleOptionalTools,
      omittedOptionalTools: [],
    });
  }

  if (missing.length > 0 || unavailableCapabilities.length > 0) {
    return emptyResult({
      status: unavailableCapabilities.length > 0 ? "unavailable" : "no_match",
      requested,
      capabilities,
      missing,
      unavailableCapabilities,
      message: buildUnavailableMessage(missing, unavailableCapabilities),
    });
  }

  const uniqueCoreTools = normalizeStrings(coreTools);
  if (uniqueCoreTools.length > maxVisibleTools) {
    return emptyResult({
      status: "surface_too_large",
      requested,
      capabilities,
      missing: uniqueCoreTools.map((tool) => `${tool} (core coverage)`),
      coverage,
      message: `The selected capabilities require ${uniqueCoreTools.length} core tools, exceeding the explicit ${maxVisibleTools}-tool surface limit. Choose fewer capabilities.`,
    });
  }

  const resolvedTools = [...uniqueCoreTools];
  const omittedOptionalTools: string[] = [];
  for (const tool of normalizeStrings(optionalTools)) {
    if (resolvedTools.includes(tool)) continue;
    if (resolvedTools.length >= maxVisibleTools) {
      omittedOptionalTools.push(tool);
      continue;
    }
    resolvedTools.push(tool);
  }
  for (const item of coverage) {
    item.omittedOptionalTools = item.optionalTools.filter((tool) => omittedOptionalTools.includes(tool));
  }

  return {
    status: omittedOptionalTools.length > 0 ? "partial" : "loaded",
    requested,
    capabilities,
    loaded: resolvedTools,
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools,
    coverage,
    message: omittedOptionalTools.length > 0
      ? `Resolved ${resolvedTools.length} tools with complete core coverage. Optional tools omitted by the explicit surface limit: ${omittedOptionalTools.join(", ")}.`
      : `Resolved ${resolvedTools.length} tools with complete core coverage for ${capabilities.join(", ")}.`,
  };
}

function resolveToolLimit(input: ResolveCapabilitySurfaceInput): number {
  const configured = Math.max(
    1,
    Math.min(
      DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS,
      Math.floor(input.maxVisibleTools ?? DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS),
    ),
  );
  return input.contextPressureActive
    ? Math.min(configured, PRESSURE_MAX_CAPABILITY_SURFACE_TOOLS)
    : configured;
}

function isToolEligibleForMode(
  mode: VirtualModeTransitionTarget,
  policy: WorkstreamBindingCapabilityPolicy,
  toolName: string,
): boolean {
  if (mode === "resolve") {
    return true;
  }
  if (!isToolAllowedByWorkstreamBinding(policy, toolName)) {
    return false;
  }
  if (
    mode === "context.retrieve"
    || mode === "observe.locate"
    || mode === "observe.investigate"
    || mode === "workstream.route"
    || mode === "validation"
  ) {
    return isObservationalTool(toolName);
  }
  return policy.workstreamBound;
}

function unavailableReason(
  policy: WorkstreamBindingCapabilityPolicy,
  tools: string[],
): CapabilityUnavailableReason {
  if (policy.workstreamBound) {
    return "not_available_after_workstream_binding";
  }
  if (tools.some(isGitContextRoutingToolName)) {
    return "routing_unavailable";
  }
  return "requires_workstream_binding";
}

function buildUnavailableMessage(
  missing: string[],
  unavailable: UnavailableCapability[],
): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`Unknown capability ids: ${missing.join(", ")}.`);
  }
  if (unavailable.length > 0) {
    parts.push(`Capabilities unavailable in this mode or authority state: ${unavailable.map((item) => item.capability).join(", ")}.`);
  }
  return parts.join(" ");
}

function emptyResult(
  input: Pick<CapabilitySurfaceResult, "status" | "requested" | "message">
    & Partial<CapabilitySurfaceResult>,
): CapabilitySurfaceResult {
  return {
    status: input.status,
    requested: input.requested,
    capabilities: input.capabilities ?? input.requested,
    loaded: input.loaded ?? [],
    alreadyActive: input.alreadyActive ?? [],
    evicted: input.evicted ?? [],
    missing: input.missing ?? [],
    unavailable: input.unavailable ?? [],
    unavailableCapabilities: input.unavailableCapabilities ?? [],
    omittedOptionalTools: input.omittedOptionalTools ?? [],
    coverage: input.coverage ?? [],
    message: input.message,
  };
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
