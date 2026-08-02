import type { RunContextMaintenancePlan } from "./run-context-maintenance-contracts.js";
import type {
  VirtualModeName,
  VirtualModeState,
} from "./virtual-mode.js";

export interface RunMaintainModeProgress {
  reason: "run_context_pressure";
  attempts: number;
  plan: RunContextMaintenancePlan;
  returnState: RunMaintainReturnState;
}

export type RunMaintainReturnState = Omit<
  VirtualModeState,
  "active" | "runMaintain" | "revision"
> & {
  active: Exclude<VirtualModeName, "context.maintain" | "run.maintain"> | null;
};

export function enterRunMaintainMode(
  previous: VirtualModeState,
  plan: RunContextMaintenancePlan,
  iteration: number,
): VirtualModeState {
  if (previous.active === "context.maintain" || previous.active === "run.maintain") {
    throw new Error("Runtime maintenance is already active.");
  }
  return {
    active: "run.maintain",
    revision: previous.revision + 1,
    operational: previous.operational,
    purpose: "Preserve the current task handoff and reduce older run tool context.",
    capabilities: [],
    targets: [],
    mutationScopes: [],
    enteredAtIteration: iteration,
    runMaintain: {
      reason: "run_context_pressure",
      attempts: 0,
      plan,
      returnState: cloneReturnState(previous),
    },
  };
}

export function recordRunMaintainAttempt(current: VirtualModeState): VirtualModeState {
  if (current.active !== "run.maintain" || !current.runMaintain) return current;
  return {
    ...current,
    revision: current.revision + 1,
    runMaintain: {
      ...current.runMaintain,
      attempts: current.runMaintain.attempts + 1,
    },
  };
}

export function restoreVirtualModeAfterRunMaintenance(
  current: VirtualModeState,
): VirtualModeState {
  if (current.active !== "run.maintain" || !current.runMaintain) return current;
  return {
    ...cloneReturnState(current.runMaintain.returnState),
    revision: current.revision + 1,
  };
}

function cloneReturnState(
  state: RunMaintainReturnState | VirtualModeState,
): RunMaintainReturnState {
  const active = state.active === "context.maintain" || state.active === "run.maintain"
    ? null
    : state.active;
  return {
    active,
    operational: state.operational,
    ...(state.purpose ? { purpose: state.purpose } : {}),
    capabilities: [...state.capabilities],
    targets: [...state.targets],
    mutationScopes: [...(state.mutationScopes ?? [])],
    ...(state.enteredAtIteration !== undefined
      ? { enteredAtIteration: state.enteredAtIteration }
      : {}),
    ...(state.validation ? {
      validation: {
        ...state.validation,
        checks: state.validation.checks.map((check) => ({ ...check })),
        criterionProofs: state.validation.criterionProofs.map((selection) => ({
          criterionIndex: selection.criterionIndex,
          outcomeRefs: [...selection.outcomeRefs],
        })),
        resourceMetadata: (state.validation.resourceMetadata ?? []).map((metadata) => ({
          ...metadata,
          aliases: [...metadata.aliases],
        })),
      },
    } : {}),
    ...(state.contextRetrieve ? {
      contextRetrieve: {
        returnState: {
          ...state.contextRetrieve.returnState,
          capabilities: [...state.contextRetrieve.returnState.capabilities],
          targets: [...state.contextRetrieve.returnState.targets],
          mutationScopes: [...state.contextRetrieve.returnState.mutationScopes],
        },
      },
    } : {}),
  };
}
