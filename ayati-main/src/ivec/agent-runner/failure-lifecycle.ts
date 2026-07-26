import type {
  FailureRecord,
  FailureRepairScope,
  FailureResolutionKind,
  LoopState,
} from "../types.js";

export interface FailureResolutionReceipt {
  iteration: number;
  kind: FailureResolutionKind;
  scopes: FailureRepairScope[];
  resolved: FailureRecord[];
}

export function appendActiveFailure(
  state: LoopState,
  failure: FailureRecord,
): FailureRecord {
  const { resolution: _resolution, ...activeFailure } = failure;
  state.failureHistory.push(activeFailure);
  return activeFailure;
}

export function getActiveFailures(
  history: LoopState["failureHistory"],
): FailureRecord[] {
  return history.filter((failure) => failure.resolution === undefined);
}

export function latestActiveFailure(
  history: LoopState["failureHistory"],
): FailureRecord | undefined {
  return [...history].reverse().find((failure) => failure.resolution === undefined);
}

export function resolveActiveFailures(
  state: LoopState,
  input: {
    scopes: FailureRepairScope[];
    iteration: number;
    kind: FailureResolutionKind;
  },
): FailureResolutionReceipt | undefined {
  const scopes = [...new Set(input.scopes)];
  const allowedScopes = new Set(scopes);
  const resolved: FailureRecord[] = [];
  for (const failure of state.failureHistory) {
    if (
      failure.resolution !== undefined
      || failure.repairScope === undefined
      || !allowedScopes.has(failure.repairScope)
    ) {
      continue;
    }
    failure.resolution = {
      iteration: input.iteration,
      kind: input.kind,
    };
    resolved.push(failure);
  }
  if (resolved.length === 0) {
    return undefined;
  }
  return {
    iteration: input.iteration,
    kind: input.kind,
    scopes,
    resolved,
  };
}
