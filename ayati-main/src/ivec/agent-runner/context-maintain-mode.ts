import type {
  VirtualModeName,
  VirtualModeState,
} from "./virtual-mode.js";

export interface ContextMaintainModeProgress {
  reason: "continuity_budget";
  protectFromSeq: number;
  continuityMaxTokens: number;
  unloadedRanges: Array<{
    fromSeq: number;
    toSeq: number;
  }>;
  returnState: ContextMaintainReturnState;
}

export type ContextMaintainReturnState = Omit<
  VirtualModeState,
  "active" | "contextMaintain" | "revision"
> & {
  active: Exclude<VirtualModeName, "context.maintain"> | null;
};

export function enterContextMaintainMode(
  previous: VirtualModeState,
  input: {
    protectFromSeq: number;
    continuityMaxTokens: number;
    unloadedRanges: Array<{ fromSeq: number; toSeq: number }>;
  },
  iteration: number,
): VirtualModeState {
  if (previous.active === "context.maintain") {
    throw new Error("Context maintenance is already active.");
  }
  return {
    active: "context.maintain",
    revision: previous.revision + 1,
    operational: previous.operational,
    purpose: "Reduce older conversation continuity while preserving the exact recent tail.",
    capabilities: [],
    targets: [],
    mutationScopes: [],
    enteredAtIteration: iteration,
    contextMaintain: {
      reason: "continuity_budget",
      protectFromSeq: input.protectFromSeq,
      continuityMaxTokens: input.continuityMaxTokens,
      unloadedRanges: input.unloadedRanges.map((range) => ({ ...range })),
      returnState: cloneReturnState(previous),
    },
  };
}

export function restoreVirtualModeAfterContextMaintenance(
  current: VirtualModeState,
): VirtualModeState {
  if (current.active !== "context.maintain" || !current.contextMaintain) {
    return current;
  }
  return {
    ...cloneReturnState(current.contextMaintain.returnState),
    revision: current.revision + 1,
  };
}

function cloneReturnState(
  state: ContextMaintainReturnState | VirtualModeState,
): ContextMaintainReturnState {
  const active = state.active === "context.maintain" ? null : state.active;
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
    ...(state.runMaintain ? {
      runMaintain: {
        ...state.runMaintain,
        plan: {
          ...state.runMaintain.plan,
          inventory: state.runMaintain.plan.inventory.map((candidate) => ({ ...candidate })),
          protectedRefs: [...state.runMaintain.plan.protectedRefs],
          entries: state.runMaintain.plan.entries.map((entry) => ({
            ...entry,
            aliases: [...entry.aliases],
          })),
        },
        returnState: {
          ...state.runMaintain.returnState,
          capabilities: [...state.runMaintain.returnState.capabilities],
          targets: [...state.runMaintain.returnState.targets],
          mutationScopes: [...state.runMaintain.returnState.mutationScopes],
        },
      },
    } : {}),
  };
}
