import {
  type FinalizeRunRequest,
  type RunWorkState,
  type RunWorkStateInput,
  type WorkstreamRequestLifecycleEffect,
} from "../contracts.js";
import { RUN_FINALIZATION_LIMITS } from "../run-finalization-limits.js";

const MISSING_ACCEPTANCE = "Run ended before final acceptance validation.";

/**
 * Supply deterministic negative completion evidence when an unsuccessful run
 * lost its model-facing bound projection before finalization. This fallback
 * can never turn a run into a successful completion.
 */
export function withUnsuccessfulBoundRunFinalization(
  input: FinalizeRunRequest,
  persistedWorkState: RunWorkState,
): FinalizeRunRequest {
  if (input.outcome === "done") {
    throw new Error("Successful bound finalization cannot use unsuccessful fallback evidence.");
  }
  const workState = unsuccessfulWorkState(input, persistedWorkState);
  return {
    ...input,
    workState,
    workstream: {
      completion: {
        accepted: false,
        resources: [],
        missing: [MISSING_ACCEPTANCE],
        failures: input.outcome === "failed" ? [input.summary] : [],
        criteria: [],
      },
      requestEffect: unsuccessfulRequestEffect(input),
    },
  };
}

function unsuccessfulWorkState(
  input: FinalizeRunRequest,
  persisted: RunWorkState,
): RunWorkStateInput {
  const maximumContext = RUN_FINALIZATION_LIMITS.workState.maximumImportantContextItems;
  const importantContext = [...persisted.importantContext];
  for (const item of input.workState.importantContext) {
    if (importantContext.length >= maximumContext) break;
    if (importantContext.some((current) => (
      current.kind === item.kind
      && current.value === item.value
      && current.ref === item.ref
    ))) continue;
    importantContext.push(item);
  }
  return {
    status: input.outcome === "blocked"
      ? "blocked"
      : input.outcome === "needs_user_input"
        ? "needs_user_input"
        : "in_progress",
    summary: input.workState.summary,
    plan: persisted.plan.map((item) => ({
      ...item,
      status: item.status === "active" ? "pending" : item.status,
    })),
    importantContext,
    nextAction: input.workState.nextAction ?? persisted.nextAction,
  };
}

function unsuccessfulRequestEffect(
  input: FinalizeRunRequest,
): WorkstreamRequestLifecycleEffect {
  if (input.outcome !== "blocked" && input.outcome !== "needs_user_input") {
    return { kind: "none" };
  }
  return {
    kind: "block",
    reason: input.next?.trim() || input.summary,
  };
}
