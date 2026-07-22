export type VirtualModeName = "observe.locate" | "observe.investigate" | "execute";

export type VirtualModeTransitionTarget = VirtualModeName | "resolve";

export type VirtualModeSource = "ENTRY" | VirtualModeName;

export interface ModeTransitionRequest {
  to: VirtualModeTransitionTarget;
  purpose: string;
  capabilities: string[];
  targets?: string[];
  binding?: import("../workstream-binding/contracts.js").WorkstreamBindingProposal;
}

export interface ValidationRequest {
  outcome: "completed" | "needs_user_input" | "blocked" | "failed";
  summary: string;
  response: string;
  resources?: import("./decision.js").WorkstreamCompletionResourceInput[];
}

export interface VirtualModeState {
  active: VirtualModeName | null;
  revision: number;
  purpose?: string;
  capabilities: string[];
  targets: string[];
  enteredAtIteration?: number;
}

export interface VirtualModeCard {
  active: VirtualModeSource;
  revision: number;
  purpose?: string;
  capabilities: string[];
  targets: string[];
  allowedNext: Array<VirtualModeTransitionTarget | "normal_reply" | "validate">;
}

export type VirtualModeRepairCode =
  | "MODE_EDGE_PROHIBITED"
  | "MODE_INPUT_INVALID"
  | "MODE_CAPABILITY_UNKNOWN"
  | "MODE_CAPABILITY_FORBIDDEN"
  | "MODE_TARGET_REQUIRED"
  | "MODE_TARGET_UNVERIFIED"
  | "MODE_MUTATION_INTENT_REQUIRED"
  | "MODE_BINDING_REQUIRED"
  | "MODE_BINDING_PROPOSAL_REQUIRED"
  | "MODE_BINDING_PROPOSAL_UNVERIFIED"
  | "MODE_RESOLUTION_AMBIGUOUS"
  | "MODE_NO_PROGRESS"
  | "MODE_RESOLUTION_UNAVAILABLE"
  | "VALIDATION_EVIDENCE_MISSING"
  | "VALIDATION_REJECTED"
  | "DIRECT_RESPONSE_REQUIRES_MODE"
  | "TERMINAL_REQUIRES_VALIDATION";

export interface VirtualModeRepair {
  code: VirtualModeRepairCode;
  message: string;
  blockedTargets: string[];
  allowedNextActions: string[];
}

export const VIRTUAL_MODE_GRAPH: Readonly<Record<VirtualModeSource, readonly VirtualModeTransitionTarget[]>> = {
  ENTRY: ["observe.locate", "observe.investigate", "resolve"],
  "observe.locate": ["observe.locate", "observe.investigate", "resolve"],
  "observe.investigate": ["observe.locate", "observe.investigate", "resolve"],
  execute: ["execute", "observe.locate", "observe.investigate"],
};

export function createEntryVirtualModeState(): VirtualModeState {
  return {
    active: null,
    revision: 0,
    capabilities: [],
    targets: [],
  };
}

export function virtualModeSource(state: VirtualModeState | undefined): VirtualModeSource {
  return state?.active ?? "ENTRY";
}

export function isVirtualGraphActive(state: VirtualModeState | undefined): boolean {
  return (state?.revision ?? 0) > 0 || state?.active != null;
}

export function allowedVirtualModeTransitions(
  state: VirtualModeState | undefined,
  options: { workstreamBound: boolean },
): VirtualModeTransitionTarget[] {
  const source = virtualModeSource(state);
  const allowed = [...VIRTUAL_MODE_GRAPH[source]];
  if (
    options.workstreamBound
    && (source === "observe.locate" || source === "observe.investigate")
  ) {
    return allowed.filter((mode) => mode !== "resolve").concat("execute");
  }
  return allowed;
}

export function isVirtualModeTransitionAllowed(
  state: VirtualModeState | undefined,
  to: VirtualModeTransitionTarget,
  options: { workstreamBound: boolean },
): boolean {
  return allowedVirtualModeTransitions(state, options).includes(to);
}

export function applyVirtualModeTransition(
  previous: VirtualModeState,
  request: ModeTransitionRequest,
  active: VirtualModeName,
  iteration: number,
): VirtualModeState {
  return {
    active,
    revision: previous.revision + 1,
    purpose: normalizeText(request.purpose),
    capabilities: normalizeStrings(request.capabilities),
    targets: normalizeStrings(request.targets ?? []),
    enteredAtIteration: iteration,
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
    purpose: normalizeText(request.purpose),
    capabilities: normalizeStrings(request.capabilities),
    targets: normalizeStrings(request.targets ?? []),
    enteredAtIteration: iteration,
  };
}

export function buildVirtualModeCard(
  state: VirtualModeState | undefined,
  options: { workstreamBound: boolean },
): VirtualModeCard {
  const current = state ?? createEntryVirtualModeState();
  const source = virtualModeSource(current);
  const allowedNext: VirtualModeCard["allowedNext"] = [
    ...allowedVirtualModeTransitions(current, options),
  ];
  if (source === "ENTRY" && !isVirtualGraphActive(current)) {
    allowedNext.unshift("normal_reply");
  }
  if (source !== "ENTRY" || isVirtualGraphActive(current)) {
    allowedNext.push("validate");
  }
  return {
    active: source,
    revision: current.revision,
    ...(current.purpose ? { purpose: current.purpose } : {}),
    capabilities: [...current.capabilities],
    targets: [...current.targets],
    allowedNext,
  };
}

export function identicalVirtualModeRequest(
  state: VirtualModeState,
  request: ModeTransitionRequest,
): boolean {
  return state.active === request.to
    && normalizeText(state.purpose ?? "") === normalizeText(request.purpose)
    && equalStrings(state.capabilities, request.capabilities)
    && equalStrings(state.targets, request.targets ?? []);
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
