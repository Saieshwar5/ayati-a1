import type { ToolExecutionContext } from "../../skills/types.js";
import type { ToolDefinition } from "../../skills/types.js";
import { requireAbsolutePath } from "../../skills/workspace-paths.js";
import {
  getToolTaxonomy,
  isObservationalTool,
} from "../../skills/tool-taxonomy.js";
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
import { CapabilityCatalog } from "./capabilities/catalog.js";
import type { CapabilitySurfaceResult } from "./capabilities/contracts.js";
import { ToolRegistry } from "./capabilities/registry.js";
import type { CapabilitySurfaceManager } from "./capabilities/surface-manager.js";
import { resolveCapabilitySurface } from "./capabilities/surface-resolver.js";
import {
  applyVirtualModeTransition,
  createVirtualModeRepair as repair,
  identicalVirtualModeRequest,
  isVirtualGraphActive,
  isVirtualModeTransitionAllowed,
  modeTransitionEvidenceTargetValues,
  modeTransitionReferenceValues,
  modeTransitionTargetValues,
  recordVirtualResolveVisit,
  type ModeTransitionRequest,
  type VirtualModeName,
  type VirtualModeRepair,
} from "./virtual-mode.js";
import { normalizeModeTransitionRequest } from "./mode-transition-request.js";
import {
  findUnverifiedVirtualModeTargets,
  isDirectFilesystemReadTransition,
} from "./virtual-mode-targets.js";
import {
  applyValidationModeEvidence,
  validationModePassed,
} from "./validation-mode.js";
import { buildCurrentRunVerificationIndex } from "./run-verification-index.js";
import { validateTaskValidationRequest } from "./task-validation-request.js";
import { canMarkTerminalReplyDone } from "./final-response-policy.js";
import { latestActiveFailure } from "./failure-lifecycle.js";
import {
  workStateBlockers,
  workStateOpenTasks,
} from "./work-state/selectors.js";
import { collectWorkstreamRoutingEvidence } from "./workstream-routing-evidence.js";
import {
  createControlOnlyWorkstreamRouteSurface,
  mountControlOnlyWorkstreamRouteSurface,
} from "./workstream-route-surface.js";

export { collectVirtualModeTargetEvidence } from "./virtual-mode-targets.js";

const MAX_MODE_PURPOSE_CHARS = 500;
const MAX_MODE_CAPABILITIES = 3;
const MAX_MODE_TARGETS = 12;

export type { VirtualModeRepair, VirtualModeRepairCode } from "./virtual-mode.js";

export type VirtualModeTransitionResult =
  | {
      kind: "applied";
      active: VirtualModeName;
      toolNames: string[];
      loadResult: CapabilitySurfaceResult;
    }
  | {
      kind: "resolved";
      active: "execute";
      toolNames: string[];
      loadResult: CapabilitySurfaceResult;
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
      noProgressResult?: CapabilitySurfaceResult;
    };

export async function dispatchVirtualModeTransition(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  workspaceRoot: string;
  iteration: number;
  toolDefinitions: ToolDefinition[];
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  toolContext: ToolExecutionContext;
  workstreamBinding?: WorkstreamBindingCoordinator;
  bindingAlreadyAttempted: boolean;
  applyContext(context: ContextEngineMachineContext): void;
  onBindingEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<VirtualModeTransitionResult> {
  const request = normalizeModeTransitionRequest(input.request);
  const basicRepair = validateModeTransitionRequest(input.state, request);
  if (basicRepair) return { kind: "rejected", repair: basicRepair };

  const capabilityResolution = request.to === "workstream.route"
    ? createControlOnlyWorkstreamRouteSurface()
    : resolveCapabilities({
        state: input.state,
        mode: request.to,
        capabilities: request.capabilities,
        toolDefinitions: input.toolDefinitions,
        capabilitySurfaceManager: input.capabilitySurfaceManager,
      });
  if (capabilityResolution.missing.length > 0) {
    return {
      kind: "rejected",
      repair: repair(
        "MODE_CAPABILITY_UNKNOWN",
        `Unknown capability ids: ${capabilityResolution.missing.join(", ")}.`,
        capabilityResolution.missing,
        ["Choose one to three exact capability ids from the destination-specific catalog."],
      ),
    };
  }
  if (capabilityResolution.status === "surface_too_large") {
    return {
      kind: "rejected",
      repair: repair(
        "MODE_CAPABILITY_SURFACE_TOO_LARGE",
        capabilityResolution.message,
        request.capabilities,
        ["Choose fewer capabilities so every selected capability keeps complete core-tool coverage."],
      ),
    };
  }
  if (capabilityResolution.unavailableCapabilities.length > 0) {
    return {
      kind: "rejected",
      repair: repair(
        request.to === "execute" ? "MODE_BINDING_REQUIRED" : "MODE_CAPABILITY_FORBIDDEN",
        capabilityResolution.message,
        request.capabilities,
        ["Choose capability ids listed for the requested destination and current authority state."],
      ),
    };
  }

  const targetRepair = await validateTransitionTargets(input.state, request);
  if (targetRepair) return { kind: "rejected", repair: targetRepair };

  if (request.to === "resolve") {
    return await dispatchResolveTransition({
      ...input,
      request,
      resolvedToolNames: capabilityResolution.loaded,
    });
  }

  if (identicalVirtualModeRequest(input.state.virtualMode, request)) {
    const active = capabilityResolution.loaded;
    return {
      kind: "rejected",
      repair: repair(
        "MODE_NO_PROGRESS",
        `The ${request.to} mode already has the same purpose, capabilities, and targets.`,
        request.capabilities,
        ["Use an active executable tool, validate the outcome, or change the mode capability surface."],
      ),
      noProgressResult: noProgressCapabilitySurfaceResult(request, active),
    };
  }

  const eligibleToolNames = capabilityResolution.loaded;
  if (
    eligibleToolNames.length === 0
    && request.to !== "validation"
    && request.to !== "workstream.route"
  ) {
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
          : ["Choose a read-only capability id such as file:search or file:read."],
      ),
    };
  }

  const loadResult = mountModeTools({
    state: input.state,
    request,
    toolNames: eligibleToolNames,
    capabilitySurfaceManager: input.capabilitySurfaceManager,
    toolContext: input.toolContext,
  });
  input.state.virtualMode = applyVirtualModeTransition(
    input.state.virtualMode,
    request,
    request.to,
    input.iteration,
  );
  if (request.to === "validation") {
    applyValidationModeEvidence(
      input.state.virtualMode,
      buildCurrentRunVerificationIndex({
        runId: input.state.runId,
        calls: input.state.toolContext?.toolCalls,
      }),
    );
  }
  input.state.lastCapabilitySurface = loadResult;
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
  workspaceRoot: string;
  iteration: number;
  resolvedToolNames: string[];
  toolDefinitions: ToolDefinition[];
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  toolContext: ToolExecutionContext;
  workstreamBinding?: WorkstreamBindingCoordinator;
  bindingAlreadyAttempted: boolean;
  applyContext(context: ContextEngineMachineContext): void;
  onBindingEvent?(event: string, data: Record<string, unknown>): void;
}): Promise<VirtualModeTransitionResult> {
  const binding = await dispatchDeterministicResolveGate({
    state: input.state,
    request: input.request,
    workspaceRoot: input.workspaceRoot,
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
        modeTransitionTargetValues(input.request),
        ["Validate a truthful failure or needs-input outcome; do not replay a mutation."],
      ),
    };
  }

  const executeSurface = resolveCapabilities({
    state: input.state,
    mode: "execute",
    capabilities: input.request.capabilities,
    toolDefinitions: input.toolDefinitions,
    capabilitySurfaceManager: input.capabilitySurfaceManager,
  });
  const executeToolNames = executeSurface.loaded;
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
    capabilitySurfaceManager: input.capabilitySurfaceManager,
    toolContext: input.toolContext,
  });
  const executeState = applyVirtualModeTransition(
    input.state.virtualMode,
    input.request,
    "execute",
    input.iteration,
  );
  if (binding.kind === "resolved" && binding.mutationRoots.length > 0) {
    executeState.mutationScopes = [...binding.mutationRoots];
  }
  input.state.virtualMode = executeState;
  input.state.lastCapabilitySurface = loadResult;
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
  const catalog = new CapabilityCatalog();
  const names = definitions
    .filter((tool) => catalog.capabilitiesForTool(tool.name)
      .some((capability) => requestedCapabilities.has(capability.id)))
    .map((tool) => tool.name);
  const allowed = new Set(filterToolsForMode(state, active, names));
  return definitions.filter((tool) => allowed.has(tool.name));
}

export function buildVirtualCapabilitySummary(definitions: ToolDefinition[]): string {
  const registry = new ToolRegistry(definitions);
  const catalog = new CapabilityCatalog();
  const cards = catalog.cardsForModes(
    [
      "context.retrieve",
      "observe.locate",
      "observe.investigate",
      "workstream.route",
      "resolve",
      "execute",
      "validation",
    ],
    registry.nameSet(),
  );
  return cards.length > 0
    ? cards.map((card) => `- ${card.id}: ${card.summary}`).join("\n")
    : "No capability ids are registered.";
}

export function directResponseRepair(state: LoopState): VirtualModeRepair | undefined {
  if (state.virtualMode.active === "context.retrieve") {
    return repair(
      "MODE_EDGE_PROHIBITED",
      "Context retrieval must call context_load before returning to the preceding mode.",
      state.hotContext.available.map((entry) => entry.key),
      ["Call context_load with the relevant available keys, or let a failed load return automatically."],
    );
  }
  if (validationModePassed(state.virtualMode)) {
    const activeFailure = latestActiveFailure(state.failureHistory);
    if (
      !activeFailure
      && (state.workState.status === "done" || canMarkTerminalReplyDone(state))
    ) {
      return undefined;
    }
    return repair(
      "VALIDATION_REJECTED",
      activeFailure
        ? "The selected task outcomes passed, but an unresolved current-run failure still blocks completion."
        : "The selected task outcomes passed, but WorkState still reports unfinished work or a blocker.",
      [
        ...(activeFailure ? [activeFailure.reason] : []),
        ...workStateOpenTasks(state.workState),
        ...workStateBlockers(state.workState),
      ],
      ["Return to the appropriate work mode, finish or repair the remaining work, then validate again."],
    );
  }
  if (isVirtualGraphActive(state.virtualMode)) {
    return repair(
      "TERMINAL_REQUIRES_VALIDATION",
      state.virtualMode.active === "validation"
        ? "Final validation has not passed, so a completed response is not allowed."
        : "A virtual mode is active, so the agent must enter validation and verify the important responsibility outcomes before responding.",
      state.virtualMode.targets,
      state.virtualMode.active === "validation"
        ? ["Return to the appropriate work mode, produce the missing verified proof once, then enter validation again."]
        : ["Transition to validation with only the exact important current-run outcome checks."],
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
    routingObserved: collectWorkstreamRoutingEvidence(state).observed,
  })) {
    return repair(
      "MODE_EDGE_PROHIBITED",
      `Transition ${state.virtualMode.active ?? "ENTRY"} -> ${request.to} is prohibited.`,
      [request.to],
      ["Choose one of the allowedNext values in context.run.mode."],
    );
  }
  if (
    request.to === "context.retrieve"
    && state.hotContext.available.length === 0
  ) {
    return repair(
      "MODE_NO_PROGRESS",
      "No unloaded Hot Context entry is currently available.",
      [],
      ["Continue in the current mode using the context already present."],
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
  if (
    request.to === "workstream.route"
    && request.capabilities.length > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "workstream.route is a control-only binding stage and accepts no capabilities.",
      request.capabilities,
      ["Remove capabilities and enter routing only after verified current-run workstream observation."],
    );
  }
  if (
    request.to !== "workstream.route"
    && (
      request.capabilities.length === 0
      || request.capabilities.length > MAX_MODE_CAPABILITIES
    )
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      `Mode transitions require 1-${MAX_MODE_CAPABILITIES} exact capability ids.`,
      request.capabilities,
      ["Choose focused ids from the capability catalog."],
    );
  }
  const targets = modeTransitionTargetValues(request);
  if (
    request.to === "workstream.route"
    && targets.length > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "workstream.route accepts no search subjects, references, targets, or mutation scopes.",
      targets,
      ["Keep verified observations in the current run and enter routing with only a concise purpose."],
    );
  }
  if (targets.length > MAX_MODE_TARGETS) {
    return repair(
      "MODE_INPUT_INVALID",
      `Mode transitions allow at most ${MAX_MODE_TARGETS} exact targets.`,
      targets,
      ["Keep only targets needed for the immediate mode."],
    );
  }
  const typedInputRepair = validateTypedModeInputs(request);
  if (typedInputRepair) return typedInputRepair;
  if (request.to !== "resolve" && request.binding) {
    return repair(
      "MODE_INPUT_INVALID",
      "A workstream binding proposal is valid only for the resolve gate.",
      targets,
      ["Remove binding outside resolve, or transition to resolve after routing observation."],
    );
  }
  if (request.to === "execute" && !isWorkstreamBound(state)) {
    return repair(
      "MODE_BINDING_REQUIRED",
      "Execute mode cannot be entered before authoritative workstream binding.",
      targets,
      ["Route ownership, then use resolve with observed activation authority or typed workspace creation targets."],
    );
  }
  return undefined;
}

async function validateTransitionTargets(
  state: LoopState,
  request: ModeTransitionRequest,
): Promise<VirtualModeRepair | undefined> {
  const allTargets = modeTransitionEvidenceTargetValues(request);
  const targets = request.to === "resolve" && request.binding?.kind === "create"
    ? modeTransitionReferenceValues(request)
    : request.to === "resolve" && request.binding?.kind === "activate"
      ? []
      : allTargets;
  if (request.to === "validation") {
    return undefined;
  }
  const requiredTargetKind = request.to === "observe.investigate"
    ? "read-only reference"
    : request.binding?.kind === "create"
      ? "workspace target"
      : request.binding?.kind === "activate"
        ? "routed resource"
        : "mutation scope";
  const targetlessInvestigation = request.to === "observe.investigate"
    && !new CapabilityCatalog().requiresReferenceTarget(
      request.capabilities,
    );
  if (
    request.to !== "context.retrieve"
    && request.to !== "observe.locate"
    && request.to !== "workstream.route"
    && !targetlessInvestigation
    && allTargets.length === 0
  ) {
    return repair(
      "MODE_TARGET_REQUIRED",
      `${request.to} requires at least one exact ${requiredTargetKind}.`,
      [],
      ["Locate the target first, then use its exact reference, routed resource ID, or bound mutation scope."],
    );
  }
  if (targets.length === 0) return undefined;
  if (isDirectFilesystemReadTransition(request)) return undefined;
  const unverified = await findUnverifiedVirtualModeTargets(state, targets, {
    includeRecentFileNavigation: request.to === "observe.investigate",
  });
  if (unverified.length === 0) return undefined;
  return repair(
    "MODE_TARGET_UNVERIFIED",
    `Targets are not grounded in current input, ingress resources, locate evidence, verified evidence, or bound resources: ${unverified.join(", ")}.`,
    unverified,
    ["Locate the target first, or use an exact target already present in authoritative context."],
  );
}

function validateTypedModeInputs(request: ModeTransitionRequest): VirtualModeRepair | undefined {
  const targets = modeTransitionTargetValues(request);
  if (
    request.to !== "observe.locate"
    && (request.subjects?.length ?? 0) > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "Search subjects are valid only in observe.locate.",
      request.subjects ?? [],
      ["Use workstream:search or resource:ownership in observe.locate, then enter workstream.route after evidence exists."],
    );
  }
  if (
    (
      request.to === "observe.locate"
      || request.to === "context.retrieve"
      || request.to === "observe.investigate"
      || request.to === "workstream.route"
      || request.to === "validation"
    )
    && (request.mutationScopes?.length ?? 0) > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "Mutation scopes are valid only for resolve or execute.",
      targets,
      ["Use references for read-only investigation."],
    );
  }
  if (
    request.to !== "resolve"
    && (request.workspaceTargets?.length ?? 0) > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "Workspace targets are valid only when creating a workstream through resolve.",
      request.workspaceTargets?.map((target) => target.relativePath) ?? [],
      ["Remove workspaceTargets outside decision_resolve_create."],
    );
  }
  if (request.to === "resolve" && request.binding?.kind === "create") {
    if ((request.workspaceTargets?.length ?? 0) === 0) {
      return repair(
        "MODE_TARGET_REQUIRED",
        "New workstream creation requires at least one typed workspace file or directory target.",
        [],
        ["Declare workspaceTargets with kind and relativePath under context.run.workspaceRoot."],
      );
    }
    if ((request.mutationScopes?.length ?? 0) > 0) {
      return repair(
        "MODE_INPUT_INVALID",
        "New workstream creation uses workspaceTargets; the model must not provide mutationScopes.",
        targets,
        ["Remove mutationScopes and declare exact workspace-relative file or directory targets."],
      );
    }
  }
  if (
    request.to === "resolve"
    && request.binding?.kind === "activate"
    && (request.workspaceTargets?.length ?? 0) > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "Existing-workstream activation uses exact existing resource IDs, not new workspace targets.",
      request.workspaceTargets?.map((target) => target.relativePath) ?? [],
      ["Use exact resourceIds returned by current-run routing."],
    );
  }
  if (
    request.to === "resolve"
    && request.binding?.kind === "activate"
    && (request.mutationScopes?.length ?? 0) > 0
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "The runtime derives existing-workstream mutation scope from routed resource IDs.",
      request.mutationScopes?.map((scope) => (
        scope.kind === "filesystem" ? scope.path : scope.resourceId
      )) ?? [],
      ["Remove mutationScopes and use exact resourceIds returned by current-run routing."],
    );
  }
  if (
    request.to === "context.retrieve"
    && (
      (request.references?.length ?? 0) > 0
      || (request.targets?.length ?? 0) > 0
    )
  ) {
    return repair(
      "MODE_INPUT_INVALID",
      "Context retrieval accepts capability ids only; it does not accept operational targets or resource references.",
      targets,
      ["Remove targets and references, then use context_load with keys advertised in context.hot.available."],
    );
  }
  if (request.to !== "validation" && (request.validationChecks?.length ?? 0) > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      "Validation checks are valid only in validation mode.",
      request.validationChecks?.map((check) => check.subject) ?? [],
      ["Remove validationChecks or transition to validation after the responsibility appears fulfilled."],
    );
  }
  if (request.to !== "validation" && (request.resourceMetadata?.length ?? 0) > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      "Resource metadata proposals are valid only in validation mode.",
      request.resourceMetadata?.map((metadata) => metadata.path) ?? [],
      ["Remove resourceMetadata or provide it with exact validation checks."],
    );
  }
  if (request.to === "validation") {
    const issue = validateTaskValidationRequest(request.validationChecks);
    if (issue) {
      return repair(
        (request.validationChecks?.length ?? 0) === 0
          ? "MODE_TARGET_REQUIRED"
          : "MODE_INPUT_INVALID",
        issue.message,
        issue.subjects,
        issue.allowedNextActions,
      );
    }
    const validationSubjects = new Set(
      (request.validationChecks ?? []).map((check) => check.subject),
    );
    const unmatchedMetadata = (request.resourceMetadata ?? [])
      .filter((metadata) => !validationSubjects.has(metadata.path))
      .map((metadata) => metadata.path);
    if (unmatchedMetadata.length > 0) {
      return repair(
        "MODE_INPUT_INVALID",
        "Resource metadata must refer to an exact path named by validationChecks.",
        unmatchedMetadata,
        ["Remove unmatched metadata or add the exact verified path to validationChecks."],
      );
    }
  }

  const invalidPaths = [
    ...(request.references ?? [])
      .filter((reference) => reference.kind === "filesystem")
      .map((reference) => reference.path),
    ...(request.mutationScopes ?? [])
      .filter((scope) => scope.kind === "filesystem")
      .map((scope) => scope.path),
    ...(request.resourceMetadata ?? []).map((metadata) => metadata.path),
  ].filter((path) => !requireAbsolutePath(path).ok);
  if (invalidPaths.length > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      `Filesystem path fields must be canonical absolute paths: ${invalidPaths.join(", ")}.`,
      invalidPaths,
      ["Use an absolute path returned by current input or authoritative resource context."],
    );
  }

  const invalidResourceIds = [
    ...(request.references ?? [])
      .filter((reference) => reference.kind === "resource")
      .map((reference) => reference.resourceId),
    ...(request.mutationScopes ?? [])
      .filter((scope) => scope.kind === "resource")
      .map((scope) => scope.resourceId),
  ].filter((resourceId) => !/^RES-[0-9A-F]{24}$/.test(resourceId));
  if (invalidResourceIds.length > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      `Resource references must use exact authoritative resource IDs: ${invalidResourceIds.join(", ")}.`,
      invalidResourceIds,
      ["Copy resourceId from current authoritative context."],
    );
  }

  const invalidWorkstreamIds = (request.references ?? [])
    .filter((reference) => reference.kind === "workstream")
    .map((reference) => reference.workstreamId)
    .filter((workstreamId) => !/^W-[0-9]{8}-[0-9]{4}$/.test(workstreamId));
  if (invalidWorkstreamIds.length > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      `Workstream references must use exact authoritative IDs: ${invalidWorkstreamIds.join(", ")}.`,
      invalidWorkstreamIds,
      ["Copy workstreamId from current routing context."],
    );
  }

  const invalidUrls = (request.references ?? [])
    .filter((reference) => reference.kind === "url")
    .map((reference) => reference.url)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol !== "http:" && parsed.protocol !== "https:";
      } catch {
        return true;
      }
    });
  if (invalidUrls.length > 0) {
    return repair(
      "MODE_INPUT_INVALID",
      `URL references must use canonical HTTP(S) URLs: ${invalidUrls.join(", ")}.`,
      invalidUrls,
      ["Use an exact HTTP(S) URL returned by current input or authoritative resource context."],
    );
  }
  return undefined;
}

function resolveCapabilities(input: {
  state: LoopState;
  mode: import("./virtual-mode.js").VirtualModeTransitionTarget;
  capabilities: string[];
  toolDefinitions: ToolDefinition[];
  capabilitySurfaceManager?: CapabilitySurfaceManager;
}): CapabilitySurfaceResult {
  if (input.capabilitySurfaceManager) {
    return input.capabilitySurfaceManager.resolveCapabilities({
      state: input.state,
      mode: input.mode,
      capabilities: input.capabilities,
    });
  }
  return resolveCapabilitySurface({
    catalog: new CapabilityCatalog(),
    registry: new ToolRegistry(input.toolDefinitions),
    capabilities: input.capabilities,
    mode: input.mode,
    policy: deriveWorkstreamBindingCapabilityPolicy(input.state),
    allowPartialRegistry: true,
  });
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
  });
}

function mountModeTools(input: {
  state: LoopState;
  request: ModeTransitionRequest;
  toolNames: string[];
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  toolContext: ToolExecutionContext;
}): CapabilitySurfaceResult {
  if (input.request.to === "workstream.route") {
    return mountControlOnlyWorkstreamRouteSurface(input);
  }
  if (input.capabilitySurfaceManager) {
    const result = input.capabilitySurfaceManager.replaceWithCapabilities({
      capabilities: input.request.capabilities,
      mode: input.request.to === "resolve" ? "execute" : input.request.to,
      state: input.state,
      context: input.toolContext,
    });
    return {
      ...result,
      requested: [...input.request.capabilities],
    };
  }
  return {
    status: "loaded",
    requested: [...input.request.capabilities],
    capabilities: [...input.request.capabilities],
    loaded: [...input.toolNames],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools: [],
    coverage: [],
    message: `Activated ${input.toolNames.length} concrete tools for ${input.request.to}.`,
  };
}

function noProgressCapabilitySurfaceResult(
  request: ModeTransitionRequest,
  activeTools: string[],
): CapabilitySurfaceResult {
  return {
    status: "already_active",
    requested: [...request.capabilities],
    capabilities: [...request.capabilities],
    loaded: [],
    alreadyActive: [...activeTools],
    evicted: [],
    missing: activeTools.length === 0 ? request.capabilities : [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools: [],
    coverage: [],
    message: `The requested ${request.to} capability surface is already active.`,
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}
