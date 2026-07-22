import type { ToolExecutionContext } from "../../skills/types.js";
import type { ToolDefinition } from "../../skills/types.js";
import {
  getToolLoadGroups,
  getToolTaxonomy,
  isObservationalTool,
} from "../../skills/tool-taxonomy.js";
import {
  isGitContextRoutingSupportToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LoopState } from "../types.js";
import type { WorkstreamBindingCoordinator } from "../workstream-binding/contracts.js";
import {
  dispatchDeterministicResolveGate,
  type DeterministicResolveGateResult,
} from "./deterministic-resolve.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  isToolAllowedByWorkstreamBinding,
} from "./workstream-binding-capability-policy.js";
import type { ToolLoadResult, ToolWorkingSetManager } from "./tool-working-set.js";
import { requiresOperationalMode } from "./turn-intent-policy.js";
import {
  applyVirtualModeTransition,
  createVirtualModeRepair as repair,
  identicalVirtualModeRequest,
  isVirtualGraphActive,
  isVirtualModeTransitionAllowed,
  recordVirtualResolveVisit,
  type ModeTransitionRequest,
  type VirtualModeName,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import {
  collectVirtualModeTargetEvidence,
  findUnverifiedVirtualModeTargets,
} from "./virtual-mode-targets.js";

export { collectVirtualModeTargetEvidence } from "./virtual-mode-targets.js";
export { dispatchVirtualValidation } from "./virtual-mode-validation.js";
export type { VirtualValidationResult } from "./virtual-mode-validation.js";

const MAX_MODE_PURPOSE_CHARS = 500;
const MAX_MODE_CAPABILITIES = 8;
const MAX_MODE_TARGETS = 12;

export type { VirtualModeRepair, VirtualModeRepairCode } from "./virtual-mode.js";

export type VirtualModeTransitionResult =
  | {
      kind: "applied";
      active: VirtualModeName;
      toolNames: string[];
      loadResult: ToolLoadResult;
    }
  | {
      kind: "resolved";
      active: "execute";
      toolNames: string[];
      loadResult: ToolLoadResult;
      binding: Extract<DeterministicResolveGateResult, { kind: "resolved" | "not_required" }>;
    }
  | {
      kind: "binding_needs_user_input";
      binding: Extract<DeterministicResolveGateResult, { kind: "needs_user_input" }>;
      question: string;
    }
  | {
      kind: "binding_failed";
      binding: Extract<DeterministicResolveGateResult, { kind: "failed" }>;
      message: string;
    }
  | {
      kind: "rejected";
      repair: VirtualModeRepair;
      noProgressResult?: ToolLoadResult;
    };

export async function dispatchVirtualModeTransition(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  iteration: number;
  toolDefinitions: ToolDefinition[];
  toolWorkingSetManager?: ToolWorkingSetManager;
  toolContext: ToolExecutionContext;
  workstreamBinding?: WorkstreamBindingCoordinator;
  bindingAlreadyAttempted: boolean;
  applyContext(context: ContextEngineMachineContext): void;
  onBindingEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<VirtualModeTransitionResult> {
  const request = normalizeModeTransitionRequest(input.request);
  const basicRepair = validateModeTransitionRequest(input.state, request);
  if (basicRepair) return { kind: "rejected", repair: basicRepair };

  const capabilityResolution = resolveCapabilities({
    capabilities: request.capabilities,
    toolDefinitions: input.toolDefinitions,
    toolWorkingSetManager: input.toolWorkingSetManager,
  });
  if (capabilityResolution.missingCapabilities.length > 0) {
    return {
      kind: "rejected",
      repair: repair(
        "MODE_CAPABILITY_UNKNOWN",
        `Unknown capability groups: ${capabilityResolution.missingCapabilities.join(", ")}.`,
        capabilityResolution.missingCapabilities,
        ["Choose one or more exact capability groups from the capability catalog."],
      ),
    };
  }

  const targetRepair = validateTransitionTargets(input.state, request);
  if (targetRepair) return { kind: "rejected", repair: targetRepair };

  if (request.to === "resolve") {
    return await dispatchResolveTransition({
      ...input,
      request,
      resolvedToolNames: capabilityResolution.toolNames,
    });
  }

  if (identicalVirtualModeRequest(input.state.virtualMode, request)) {
    const active = filterToolsForMode(input.state, request.to, capabilityResolution.toolNames);
    return {
      kind: "rejected",
      repair: repair(
        "MODE_NO_PROGRESS",
        `The ${request.to} mode already has the same purpose, capabilities, and targets.`,
        request.capabilities,
        ["Use an active executable tool, validate the outcome, or change the mode capability surface."],
      ),
      noProgressResult: noProgressToolLoadResult(request, active),
    };
  }

  const eligibleToolNames = filterToolsForMode(input.state, request.to, capabilityResolution.toolNames);
  if (eligibleToolNames.length === 0) {
    return {
      kind: "rejected",
      repair: repair(
        request.to === "execute" ? "MODE_BINDING_REQUIRED" : "MODE_CAPABILITY_FORBIDDEN",
        request.to === "execute"
          ? "Execute mode requires an authoritative workstream binding and at least one capability allowed by the bound-resource policy."
          : `${request.to} accepts read-only list, search, and read capabilities only.`,
        request.capabilities,
        request.to === "execute"
          ? ["Resolve the mutation-capable request before entering execute mode."]
          : ["Choose a read-only capability group such as file:search or file:read."],
      ),
    };
  }

  const loadResult = mountModeTools({
    state: input.state,
    request,
    toolNames: eligibleToolNames,
    toolWorkingSetManager: input.toolWorkingSetManager,
    toolContext: input.toolContext,
  });
  input.state.virtualMode = applyVirtualModeTransition(
    input.state.virtualMode,
    request,
    request.to,
    input.iteration,
  );
  input.state.lastToolLoad = loadResult;
  return {
    kind: "applied",
    active: request.to,
    toolNames: eligibleToolNames,
    loadResult,
  };
}

async function dispatchResolveTransition(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  iteration: number;
  resolvedToolNames: string[];
  toolDefinitions: ToolDefinition[];
  toolWorkingSetManager?: ToolWorkingSetManager;
  toolContext: ToolExecutionContext;
  workstreamBinding?: WorkstreamBindingCoordinator;
  bindingAlreadyAttempted: boolean;
  applyContext(context: ContextEngineMachineContext): void;
  onBindingEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<VirtualModeTransitionResult> {
  const binding = await dispatchDeterministicResolveGate({
    state: input.state,
    request: input.request,
    toolNames: input.resolvedToolNames,
    coordinator: input.workstreamBinding,
    alreadyAttempted: input.bindingAlreadyAttempted,
    onEvent: input.onBindingEvent,
  });
  if (binding.kind === "rejected") {
    input.state.virtualMode = recordVirtualResolveVisit(
      input.state.virtualMode,
      input.request,
      input.iteration,
    );
    return { kind: "rejected", repair: binding.repair };
  }
  if (binding.kind === "needs_user_input") {
    input.state.virtualMode = recordVirtualResolveVisit(
      input.state.virtualMode,
      input.request,
      input.iteration,
    );
    return {
      kind: "binding_needs_user_input",
      binding,
      question: binding.outcome.question,
    };
  }
  if (binding.kind === "failed") {
    input.state.virtualMode = recordVirtualResolveVisit(
      input.state.virtualMode,
      input.request,
      input.iteration,
    );
    return {
      kind: "binding_failed",
      binding,
      message: `Deterministic workstream binding failed: ${binding.outcome.message}`,
    };
  }
  if (binding.kind === "resolved") {
    input.state.virtualMode = recordVirtualResolveVisit(
      input.state.virtualMode,
      input.request,
      input.iteration,
    );
    input.applyContext(binding.outcome.context);
  } else if (!isWorkstreamBound(input.state)) {
    return {
      kind: "rejected",
      repair: repair(
        "MODE_RESOLUTION_UNAVAILABLE",
        "The deterministic resolve gate did not establish an authoritative binding.",
        input.request.targets ?? [],
        ["Validate a truthful failure or needs-input outcome; do not replay a mutation."],
      ),
    };
  }

  const executeToolNames = filterToolsForMode(input.state, "execute", input.resolvedToolNames);
  if (executeToolNames.length === 0) {
    return {
      kind: "binding_failed",
      binding: {
        kind: "failed",
        attempted: true,
        toolNames: input.resolvedToolNames,
        outcome: {
          status: "failed",
          code: "WORKSTREAM_BINDING_CAPABILITY_FORBIDDEN",
          message: "Binding succeeded but no requested concrete tools were eligible under bound policy.",
          retryable: false,
        },
      },
      message: "Binding succeeded, but the requested capability surface was not allowed by the authoritative bound-resource policy.",
    };
  }
  const loadResult = mountModeTools({
    state: input.state,
    request: input.request,
    toolNames: executeToolNames,
    toolWorkingSetManager: input.toolWorkingSetManager,
    toolContext: input.toolContext,
  });
  input.state.virtualMode = applyVirtualModeTransition(
    input.state.virtualMode,
    input.request,
    "execute",
    input.iteration,
  );
  input.state.lastToolLoad = loadResult;
  return {
    kind: "resolved",
    active: "execute",
    toolNames: executeToolNames,
    loadResult,
    binding,
  };
}

export function filterToolDefinitionsForVirtualMode(
  state: LoopState,
  definitions: ToolDefinition[],
): ToolDefinition[] {
  const active = state.virtualMode.active;
  if (!active) return [];
  const requestedCapabilities = new Set(state.virtualMode.capabilities);
  const names = definitions
    .filter((tool) => getToolLoadGroups(tool.name).some((group) => requestedCapabilities.has(group)))
    .map((tool) => tool.name);
  const allowed = new Set(filterToolsForMode(state, active, names));
  return definitions.filter((tool) => allowed.has(tool.name));
}

export function buildVirtualCapabilitySummary(definitions: ToolDefinition[]): string {
  const groups = [...new Set(definitions
    .filter((tool) => !isGitContextTurnRoutingToolName(tool.name)
      && !isGitContextRoutingSupportToolName(tool.name))
    .flatMap((tool) => getToolLoadGroups(tool.name)))]
    .filter((group) => group.includes(":"))
    .sort()
    .slice(0, 60);
  return groups.length > 0
    ? `Available capability groups: ${groups.join(", ")}.`
    : "No capability groups are registered.";
}

export function directResponseRepair(state: LoopState): VirtualModeRepair | undefined {
  if (isVirtualGraphActive(state.virtualMode)) {
    return repair(
      "TERMINAL_REQUIRES_VALIDATION",
      "A virtual mode is active, so terminal outcomes must use decision_validate.",
      state.virtualMode.targets,
      ["Call decision_validate with the truthful outcome, summary, and complete user-facing response."],
    );
  }
  if (requiresOperationalMode(state.userMessage)) {
    return repair(
      "DIRECT_RESPONSE_REQUIRES_MODE",
      "The current request explicitly requires observation or mutation that has not been performed.",
      collectVirtualModeTargetEvidence(state),
      ["Enter an observation mode, or enter resolve for an evidence-backed mutation target."],
    );
  }
  return undefined;
}

function validateModeTransitionRequest(
  state: LoopState,
  request: ModeTransitionRequest,
): VirtualModeRepair | undefined {
  if (!isVirtualModeTransitionAllowed(state.virtualMode, request.to, {
    workstreamBound: isWorkstreamBound(state),
  })) {
    return repair(
      "MODE_EDGE_PROHIBITED",
      `Transition ${state.virtualMode.active ?? "ENTRY"} -> ${request.to} is prohibited.`,
      [request.to],
      ["Choose one of the allowedNext values in context.run.mode."],
    );
  }
  if (!request.purpose || request.purpose.length > MAX_MODE_PURPOSE_CHARS) {
    return repair(
      "MODE_INPUT_INVALID",
      `Mode purpose must contain 1-${MAX_MODE_PURPOSE_CHARS} characters.`,
      [],
      ["Retry with one concise sentence describing the immediate responsibility."],
    );
  }
  if (request.capabilities.length === 0 || request.capabilities.length > MAX_MODE_CAPABILITIES) {
    return repair(
      "MODE_INPUT_INVALID",
      `Mode transitions require 1-${MAX_MODE_CAPABILITIES} exact capability groups.`,
      request.capabilities,
      ["Choose focused groups from the capability catalog."],
    );
  }
  if ((request.targets?.length ?? 0) > MAX_MODE_TARGETS) {
    return repair(
      "MODE_INPUT_INVALID",
      `Mode transitions allow at most ${MAX_MODE_TARGETS} exact targets.`,
      request.targets ?? [],
      ["Keep only targets needed for the immediate mode."],
    );
  }
  if (request.to !== "resolve" && request.binding) {
    return repair(
      "MODE_INPUT_INVALID",
      "A workstream binding proposal is valid only for the resolve gate.",
      request.targets ?? [],
      ["Remove binding outside resolve, or transition to resolve after routing observation."],
    );
  }
  if (request.to === "execute" && !isWorkstreamBound(state)) {
    return repair(
      "MODE_BINDING_REQUIRED",
      "Execute mode cannot be entered before authoritative workstream binding.",
      request.targets ?? [],
      ["Use the resolve gate with a binding-required capability and evidence-backed target."],
    );
  }
  return undefined;
}

function validateTransitionTargets(
  state: LoopState,
  request: ModeTransitionRequest,
): VirtualModeRepair | undefined {
  const targets = request.targets ?? [];
  if (request.to !== "observe.locate" && targets.length === 0) {
    return repair(
      "MODE_TARGET_REQUIRED",
      `${request.to} requires at least one exact evidence-backed target.`,
      [],
      ["Use observe.locate to discover a target, or provide a target from current input or authoritative resources."],
    );
  }
  if (targets.length === 0) return undefined;
  const unverified = findUnverifiedVirtualModeTargets(state, targets);
  if (unverified.length === 0) return undefined;
  return repair(
    "MODE_TARGET_UNVERIFIED",
    `Targets are not grounded in current input, ingress resources, locate evidence, verified evidence, or bound resources: ${unverified.join(", ")}.`,
    unverified,
    ["Locate the target first, or use an exact target already present in authoritative context."],
  );
}

function resolveCapabilities(input: {
  capabilities: string[];
  toolDefinitions: ToolDefinition[];
  toolWorkingSetManager?: ToolWorkingSetManager;
}): { toolNames: string[]; missingCapabilities: string[] } {
  const byCapability = new Map<string, Set<string>>();
  for (const capability of input.capabilities) byCapability.set(capability, new Set());
  const managerResolution = input.toolWorkingSetManager?.resolveCapabilityTools(input.capabilities);
  for (const toolName of managerResolution?.toolNames ?? []) {
    for (const capability of input.capabilities) {
      if (getToolLoadGroups(toolName).includes(capability)) {
        byCapability.get(capability)?.add(toolName);
      }
    }
  }
  for (const tool of input.toolDefinitions) {
    for (const capability of input.capabilities) {
      if (getToolLoadGroups(tool.name).includes(capability)) {
        byCapability.get(capability)?.add(tool.name);
      }
    }
  }
  return {
    toolNames: [...new Set([...byCapability.values()].flatMap((names) => [...names]))],
    missingCapabilities: [...byCapability.entries()]
      .filter(([, names]) => names.size === 0)
      .map(([capability]) => capability),
  };
}

function filterToolsForMode(
  state: LoopState,
  mode: VirtualModeName,
  toolNames: string[],
): string[] {
  const policy = deriveWorkstreamBindingCapabilityPolicy(state);
  return [...new Set(toolNames)].filter((toolName) => {
    if (!getToolTaxonomy(toolName)) return false;
    if (!isToolAllowedByWorkstreamBinding(policy, toolName)) return false;
    if (mode === "observe.locate" || mode === "observe.investigate") {
      return isObservationalTool(toolName);
    }
    return policy.workstreamBound;
  });
}

function mountModeTools(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  toolNames: string[];
  toolWorkingSetManager?: ToolWorkingSetManager;
  toolContext: ToolExecutionContext;
}): ToolLoadResult {
  const policy = deriveWorkstreamBindingCapabilityPolicy(input.state);
  if (input.toolWorkingSetManager) {
    const result = input.toolWorkingSetManager.replaceWithTools(
      input.toolNames,
      input.toolContext,
      policy,
    );
    return {
      ...result,
      requested: {
        toolNames: [],
        groups: [...input.request.capabilities],
      },
    };
  }
  return {
    status: "loaded",
    requested: { toolNames: [], groups: [...input.request.capabilities] },
    loaded: [...input.toolNames],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    message: `Activated ${input.toolNames.length} concrete tools for ${input.request.to}.`,
  };
}

function noProgressToolLoadResult(
  request: ModeTransitionRequest,
  activeTools: string[],
): ToolLoadResult {
  return {
    status: "already_active",
    requested: { toolNames: [], groups: [...request.capabilities] },
    loaded: [],
    alreadyActive: [...activeTools],
    evicted: [],
    missing: activeTools.length === 0 ? request.capabilities : [],
    unavailable: [],
    message: `The requested ${request.to} capability surface is already active.`,
  };
}

function normalizeModeTransitionRequest(request: ModeTransitionRequest): ModeTransitionRequest {
  return {
    to: request.to,
    purpose: normalizeText(request.purpose),
    capabilities: normalizeStrings(request.capabilities),
    ...(request.targets ? { targets: normalizeStrings(request.targets) } : {}),
    ...(request.binding ? { binding: request.binding } : {}),
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
