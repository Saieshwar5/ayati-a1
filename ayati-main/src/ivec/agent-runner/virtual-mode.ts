import type {
  ModeTransitionValidationCheck,
  ResourceMetadataProposal,
  ValidationCriterionProofSelection,
  ValidationCheckResult,
  ValidationCheckStatus,
} from "./task-validation-contracts.js";
import type { ContextMaintainModeProgress } from "./context-maintain-mode.js";
import type { RunMaintainModeProgress } from "./run-maintain-mode.js";

export {
  enterContextMaintainMode,
  restoreVirtualModeAfterContextMaintenance,
} from "./context-maintain-mode.js";
export type {
  ContextMaintainModeProgress,
  ContextMaintainReturnState,
} from "./context-maintain-mode.js";
export {
  enterRunMaintainMode,
  recordRunMaintainAttempt,
  restoreVirtualModeAfterRunMaintenance,
} from "./run-maintain-mode.js";
export type {
  RunMaintainModeProgress,
  RunMaintainReturnState,
} from "./run-maintain-mode.js";

export type {
  FileReadValidationScope,
  ModeTransitionValidationCheck,
  ResourceMetadataProposal,
  TaskValidationOutcomeKind,
  ValidationCriterionProofSelection,
  ValidationCheckResult,
  ValidationCheckStatus,
  ValidationExpectedPathKind,
} from "./task-validation-contracts.js";

export const VIRTUAL_MODE_NAMES = [
  "context.maintain",
  "run.maintain",
  "context.retrieve",
  "observe.locate",
  "observe.investigate",
  "workstream.route",
  "execute",
  "validation",
] as const;

export type VirtualModeName = (typeof VIRTUAL_MODE_NAMES)[number];

export type VirtualModeTransitionTarget = Exclude<
  VirtualModeName,
  "context.maintain" | "run.maintain"
> | "resolve";

export type VirtualModeSource = "ENTRY" | VirtualModeName;

export function isVirtualModeName(value: unknown): value is VirtualModeName {
  return typeof value === "string"
    && (VIRTUAL_MODE_NAMES as readonly string[]).includes(value);
}

export type ModeTransitionReference =
  | {
      kind: "filesystem";
      path: string;
    }
  | {
      kind: "resource";
      resourceId: string;
    }
  | {
      kind: "workstream";
      workstreamId: string;
    }
  | {
      kind: "url";
      url: string;
    };

export type ModeTransitionMutationScope =
  | {
      kind: "filesystem";
      path: string;
    }
  | {
      kind: "resource";
      resourceId: string;
    };

export interface ValidationModeProgress {
  returnMode: Exclude<
    VirtualModeName,
    "validation" | "context.maintain" | "run.maintain" | "context.retrieve"
  >;
  status: ValidationCheckStatus;
  checks: ValidationCheckResult[];
  criterionProofs: ValidationCriterionProofSelection[];
  resourceMetadata?: ResourceMetadataProposal[];
}

export interface ContextRetrieveModeProgress {
  returnState: {
    active: Exclude<
      VirtualModeName,
      "context.maintain" | "run.maintain" | "context.retrieve"
    > | null;
    purpose?: string;
    capabilities: string[];
    targets: string[];
    mutationScopes: string[];
    enteredAtIteration?: number;
  };
}

export interface ModeTransitionRequest {
  to: VirtualModeTransitionTarget;
  purpose: string;
  capabilities: string[];
  subjects?: string[];
  references?: ModeTransitionReference[];
  mutationScopes?: ModeTransitionMutationScope[];
  workspaceTargets?: import("../workstream-binding/contracts.js").WorkstreamWorkspaceTarget[];
  outcomeRefs?: string[];
  criterionProofs?: ValidationCriterionProofSelection[];
  /** Runtime-resolved checks; never accepted from a model-facing control. */
  validationChecks?: ModeTransitionValidationCheck[];
  resourceMetadata?: ResourceMetadataProposal[];
  /**
   * Compatibility input for journaled/tests calls created before typed mode
   * references. The native model schema no longer exposes this field.
   */
  targets?: string[];
  binding?: import("../workstream-binding/contracts.js").WorkstreamBindingProposal;
}

export interface TerminalStopRequest {
  outcome: "needs_user_input" | "blocked" | "failed";
  response: string;
}

export interface VirtualModeState {
  active: VirtualModeName | null;
  revision: number;
  operational: boolean;
  purpose?: string;
  capabilities: string[];
  targets: string[];
  mutationScopes: string[];
  enteredAtIteration?: number;
  validation?: ValidationModeProgress;
  contextRetrieve?: ContextRetrieveModeProgress;
  contextMaintain?: ContextMaintainModeProgress;
  runMaintain?: RunMaintainModeProgress;
}

export interface VirtualModeCard {
  active: VirtualModeSource;
  revision: number;
  purpose?: string;
  capabilities: string[];
  targets: string[];
  allowedNext: Array<VirtualModeTransitionTarget | "normal_reply" | "stop">;
  validation?: ValidationModeProgress;
  contextRetrieve?: {
    returnTo: Exclude<VirtualModeSource, "context.retrieve">;
  };
  contextMaintain?: {
    reason: ContextMaintainModeProgress["reason"];
    returnTo: Exclude<VirtualModeSource, "context.maintain">;
    protectFromSeq: number;
    continuityMaxTokens: number;
    unloadedRanges: ContextMaintainModeProgress["unloadedRanges"];
  };
  runMaintain?: import("./run-context-maintenance-contracts.js").PromptRunContextMaintenanceCard;
}

export type VirtualModeRepairCode =
  | "MODE_EDGE_PROHIBITED"
  | "MODE_INPUT_INVALID"
  | "MODE_CAPABILITY_UNKNOWN"
  | "MODE_CAPABILITY_FORBIDDEN"
  | "MODE_CAPABILITY_SURFACE_TOO_LARGE"
  | "MODE_TARGET_REQUIRED"
  | "MODE_TARGET_UNVERIFIED"
  | "MODE_BINDING_REQUIRED"
  | "MODE_BINDING_PROPOSAL_REQUIRED"
  | "MODE_BINDING_PROPOSAL_UNVERIFIED"
  | "MODE_RESOLUTION_AMBIGUOUS"
  | "MODE_NO_PROGRESS"
  | "MODE_RESOLUTION_UNAVAILABLE"
  | "VALIDATION_REJECTED"
  | "TERMINAL_REQUIRES_VALIDATION";

export interface VirtualModeRepair {
  code: VirtualModeRepairCode;
  message: string;
  blockedTargets: string[];
  allowedNextActions: string[];
}

export const VIRTUAL_MODE_GRAPH: Readonly<Record<VirtualModeSource, readonly VirtualModeTransitionTarget[]>> = {
  ENTRY: ["context.retrieve", "observe.locate", "observe.investigate"],
  "context.maintain": [],
  "run.maintain": [],
  "context.retrieve": [],
  "observe.locate": ["context.retrieve", "observe.locate", "observe.investigate", "workstream.route", "validation"],
  "observe.investigate": ["context.retrieve", "observe.locate", "observe.investigate", "workstream.route", "validation"],
  "workstream.route": ["context.retrieve", "observe.locate", "observe.investigate", "resolve"],
  execute: ["context.retrieve", "execute", "observe.locate", "observe.investigate", "validation"],
  validation: ["observe.locate", "observe.investigate"],
};

export function createEntryVirtualModeState(): VirtualModeState {
  return {
    active: null,
    revision: 0,
    operational: false,
    capabilities: [],
    targets: [],
    mutationScopes: [],
  };
}

export function virtualModeSource(state: VirtualModeState | undefined): VirtualModeSource {
  return state?.active ?? "ENTRY";
}

export function isVirtualGraphActive(state: VirtualModeState | undefined): boolean {
  return state?.operational ?? false;
}

export function allowedVirtualModeTransitions(
  state: VirtualModeState | undefined,
  options: {
    workstreamBound: boolean;
    routingObserved?: boolean;
  },
): VirtualModeTransitionTarget[] {
  const source = virtualModeSource(state);
  const allowed = [...VIRTUAL_MODE_GRAPH[source]];
  if (options.workstreamBound && source === "ENTRY") {
    return allowed.filter((mode) => mode !== "workstream.route").concat("execute");
  }
  if (
    options.workstreamBound
    && (
      source === "observe.locate"
      || source === "observe.investigate"
      || source === "validation"
    )
  ) {
    return allowed.filter((mode) => mode !== "workstream.route").concat("execute");
  }
  if (options.workstreamBound && source === "workstream.route") {
    return ["execute"];
  }
  if (
    !options.workstreamBound
    && options.routingObserved !== true
    && source !== "workstream.route"
  ) {
    return allowed.filter((mode) => mode !== "workstream.route");
  }
  if (source === "workstream.route" && options.routingObserved !== true) {
    return allowed.filter((mode) => mode !== "resolve");
  }
  return allowed;
}

export function isVirtualModeTransitionAllowed(
  state: VirtualModeState | undefined,
  to: VirtualModeTransitionTarget,
  options: {
    workstreamBound: boolean;
    routingObserved?: boolean;
  },
): boolean {
  return allowedVirtualModeTransitions(state, options).includes(to);
}

export function applyVirtualModeTransition(
  previous: VirtualModeState,
  request: ModeTransitionRequest,
  active: VirtualModeName,
  iteration: number,
): VirtualModeState {
  const validation = active === "validation"
    ? createValidationModeProgress(previous, request)
    : undefined;
  const contextRetrieve = active === "context.retrieve"
    ? createContextRetrieveModeProgress(previous)
    : undefined;
  return {
    active,
    revision: previous.revision + 1,
    operational: previous.operational || active !== "context.retrieve",
    purpose: normalizeText(request.purpose),
    capabilities: normalizeStrings(request.capabilities),
    targets: modeTransitionTargetValues(request),
    mutationScopes: modeTransitionMutationScopeValues(request),
    enteredAtIteration: iteration,
    ...(validation ? { validation } : {}),
    ...(contextRetrieve ? { contextRetrieve } : {}),
  };
}

export function recordVirtualResolveVisit(
  previous: VirtualModeState,
  request: ModeTransitionRequest,
  iteration: number,
): VirtualModeState {
  return {
    ...previous,
    revision: previous.revision + 1,
    operational: true,
    purpose: normalizeText(request.purpose),
    capabilities: normalizeStrings(request.capabilities),
    targets: modeTransitionTargetValues(request),
    mutationScopes: modeTransitionMutationScopeValues(request),
    enteredAtIteration: iteration,
  };
}

export function buildVirtualModeCard(
  state: VirtualModeState | undefined,
  options: {
    workstreamBound: boolean;
    routingObserved?: boolean;
    hotContextAvailable?: boolean;
  },
): VirtualModeCard {
  const current = state ?? createEntryVirtualModeState();
  const source = virtualModeSource(current);
  const allowedNext: VirtualModeCard["allowedNext"] = [
    ...allowedVirtualModeTransitions(current, options),
  ].filter((destination) => (
    destination !== "context.retrieve"
    || options.hotContextAvailable !== false
  ));
  if (source === "ENTRY" && !isVirtualGraphActive(current)) {
    allowedNext.unshift("normal_reply");
  }
  if (source === "validation" && current.validation?.status === "passed") {
    allowedNext.unshift("normal_reply");
  } else if (
    source !== "ENTRY"
    && source !== "context.maintain"
    && source !== "run.maintain"
    && source !== "context.retrieve"
  ) {
    allowedNext.push("stop");
  } else if (
    source !== "context.maintain"
    && source !== "run.maintain"
    && isVirtualGraphActive(current)
  ) {
    allowedNext.push("stop");
  }
  return {
    active: source,
    revision: current.revision,
    ...(current.purpose ? { purpose: current.purpose } : {}),
    capabilities: [...current.capabilities],
    targets: [...current.targets],
    allowedNext,
    ...(current.validation ? {
      validation: {
        ...current.validation,
        checks: current.validation.checks.map((check) => ({ ...check })),
        criterionProofs: current.validation.criterionProofs.map((selection) => ({
          criterionIndex: selection.criterionIndex,
          outcomeRefs: [...selection.outcomeRefs],
        })),
        resourceMetadata: (current.validation.resourceMetadata ?? []).map((metadata) => ({
          ...metadata,
          aliases: [...metadata.aliases],
        })),
      },
    } : {}),
    ...(current.contextRetrieve ? {
      contextRetrieve: {
        returnTo: current.contextRetrieve.returnState.active ?? "ENTRY",
      },
    } : {}),
    ...(current.contextMaintain ? {
      contextMaintain: {
        reason: current.contextMaintain.reason,
        returnTo: current.contextMaintain.returnState.active ?? "ENTRY",
        protectFromSeq: current.contextMaintain.protectFromSeq,
        continuityMaxTokens: current.contextMaintain.continuityMaxTokens,
        unloadedRanges: current.contextMaintain.unloadedRanges.map((range) => ({ ...range })),
      },
    } : {}),
    ...(current.runMaintain ? {
      runMaintain: {
        reason: current.runMaintain.reason,
        maintenanceId: current.runMaintain.plan.maintenanceId,
        returnTo: current.runMaintain.returnState.active ?? "ENTRY",
        expectedWorkStateRevision: current.runMaintain.plan.expectedWorkStateRevision,
        sourceThroughStep: current.runMaintain.plan.sourceThroughStep,
        requiredSavingsTokens: current.runMaintain.plan.requiredSavingsTokens,
        candidates: current.runMaintain.plan.inventory.map((candidate) => ({ ...candidate })),
        omittedCandidateCount: current.runMaintain.plan.omittedCandidateCount,
        protectedRefs: [...current.runMaintain.plan.protectedRefs],
      },
    } : {}),
  };
}

export function restoreVirtualModeAfterContextRetrieval(
  current: VirtualModeState,
): VirtualModeState {
  if (current.active !== "context.retrieve" || !current.contextRetrieve) {
    return current;
  }
  const previous = current.contextRetrieve.returnState;
  return {
    active: previous.active,
    revision: current.revision + 1,
    operational: current.operational,
    capabilities: [...previous.capabilities],
    targets: [...previous.targets],
    mutationScopes: [...(previous.mutationScopes ?? [])],
    ...(previous.purpose ? { purpose: previous.purpose } : {}),
    ...(previous.enteredAtIteration !== undefined
      ? { enteredAtIteration: previous.enteredAtIteration }
      : {}),
  };
}

export function identicalVirtualModeRequest(
  state: VirtualModeState,
  request: ModeTransitionRequest,
): boolean {
  return state.active === request.to
    && normalizeText(state.purpose ?? "") === normalizeText(request.purpose)
    && equalStrings(state.capabilities, request.capabilities)
    && equalStrings(state.targets, modeTransitionTargetValues(request))
    && equalStrings(
      state.mutationScopes ?? [],
      modeTransitionMutationScopeValues(request),
    );
}

export function modeTransitionReferenceValues(request: ModeTransitionRequest): string[] {
  return normalizeStrings((request.references ?? []).map(referenceValue));
}

export function modeTransitionMutationScopeValues(request: ModeTransitionRequest): string[] {
  const scopes = normalizeStrings((request.mutationScopes ?? []).map(mutationScopeValue));
  if (scopes.length > 0) return scopes;
  return request.to === "resolve" || request.to === "execute"
    ? normalizeStrings(request.targets ?? [])
    : [];
}

export function modeTransitionWorkspaceTargetValues(
  request: ModeTransitionRequest,
): string[] {
  return normalizeStrings(
    (request.workspaceTargets ?? []).map((target) => target.relativePath),
  );
}

export function modeTransitionActivationResourceValues(
  request: ModeTransitionRequest,
): string[] {
  return request.binding?.kind === "activate"
    ? normalizeStrings(request.binding.resourceIds)
    : [];
}

export function modeTransitionEvidenceTargetValues(request: ModeTransitionRequest): string[] {
  const validationTargets = (request.validationChecks?.length ?? 0) > 0
    ? request.validationChecks!.map((check) => check.subject)
    : request.outcomeRefs ?? [];
  const typed = normalizeStrings([
    ...modeTransitionReferenceValues(request),
    ...modeTransitionMutationScopeValues(request),
    ...modeTransitionWorkspaceTargetValues(request),
    ...modeTransitionActivationResourceValues(request),
    ...validationTargets,
  ]);
  return typed.length > 0 ? typed : normalizeStrings(request.targets ?? []);
}

export function modeTransitionTargetValues(request: ModeTransitionRequest): string[] {
  return normalizeStrings([
    ...(request.subjects ?? []),
    ...modeTransitionEvidenceTargetValues(request),
  ]);
}

function referenceValue(reference: ModeTransitionReference): string {
  switch (reference.kind) {
    case "filesystem":
      return reference.path;
    case "resource":
      return reference.resourceId;
    case "workstream":
      return reference.workstreamId;
    case "url":
      return reference.url;
  }
}

function mutationScopeValue(scope: ModeTransitionMutationScope): string {
  return scope.kind === "filesystem" ? scope.path : scope.resourceId;
}

function createValidationModeProgress(
  previous: VirtualModeState,
  request: ModeTransitionRequest,
): ValidationModeProgress {
  const returnMode = previous.active
    && previous.active !== "validation"
    && previous.active !== "context.maintain"
    && previous.active !== "run.maintain"
    && previous.active !== "context.retrieve"
    ? previous.active
    : "observe.investigate";
  return {
    returnMode,
    status: "pending",
    checks: (request.validationChecks ?? []).map((check) => ({
      ...check,
      status: "pending",
    })),
    criterionProofs: (request.criterionProofs ?? []).map((selection) => ({
      criterionIndex: selection.criterionIndex,
      outcomeRefs: [...selection.outcomeRefs],
    })),
    resourceMetadata: (request.resourceMetadata ?? []).map((metadata) => ({
      ...metadata,
      aliases: [...metadata.aliases],
    })),
  };
}

function createContextRetrieveModeProgress(
  previous: VirtualModeState,
): ContextRetrieveModeProgress {
  return {
    returnState: {
      active: previous.active === "context.retrieve"
        || previous.active === "context.maintain"
        || previous.active === "run.maintain"
        ? null
        : previous.active,
      ...(previous.purpose ? { purpose: previous.purpose } : {}),
      capabilities: [...previous.capabilities],
      targets: [...previous.targets],
      mutationScopes: [...(previous.mutationScopes ?? [])],
      ...(previous.enteredAtIteration !== undefined
        ? { enteredAtIteration: previous.enteredAtIteration }
        : {}),
    },
  };
}

export function createVirtualModeRepair(
  code: VirtualModeRepairCode,
  message: string,
  blockedTargets: string[],
  allowedNextActions: string[],
): VirtualModeRepair {
  return {
    code,
    message: normalizeText(message).slice(0, 800),
    blockedTargets: normalizeStrings(blockedTargets).slice(0, 12),
    allowedNextActions: normalizeStrings(allowedNextActions).slice(0, 4),
  };
}

function equalStrings(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizeStrings(left);
  const normalizedRight = normalizeStrings(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
