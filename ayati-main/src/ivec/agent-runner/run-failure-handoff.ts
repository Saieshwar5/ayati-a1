import { ProviderCallError } from "../../providers/shared/provider-call-policy.js";
import { compactWorkState } from "../state-compaction.js";
import type { LoopState, WorkState } from "../types.js";
import { buildVerifiedResourceEffects } from "./verified-resource-effects.js";

export interface RunFailureHandoff {
  response: string;
  workState: WorkState;
  verifiedEffectCount: number;
}

/**
 * Close a decision-runtime failure from exact in-memory run evidence without
 * asking the provider for another response.
 */
export function buildRunFailureHandoff(state: LoopState, error?: unknown): RunFailureHandoff {
  const verifiedEffectCount = buildVerifiedResourceEffects(state).length;
  const nextAction = state.workState.nextAction?.trim()
    || state.harnessContext.contextEngine?.workstream?.selectedRequest?.request?.trim()
    || state.harnessContext.contextEngine?.workstream?.currentRequest?.request?.trim()
    || state.userMessage.trim()
    || "Continue from the latest verified state.";
  const summary = verifiedEffectCount > 0
    ? `The run stopped after preserving ${verifiedEffectCount} verified filesystem ${verifiedEffectCount === 1 ? "change" : "changes"}.`
    : "The run stopped before any new filesystem change was verified.";
  const workState = compactWorkState({
    ...state.workState,
    status: "in_progress",
    summary,
    plan: state.workState.plan.map((item) => ({
      ...item,
      status: item.status === "active" ? "pending" : item.status,
    })),
    nextAction,
  });

  return {
    response: failureResponse(error, verifiedEffectCount),
    workState,
    verifiedEffectCount,
  };
}

function failureResponse(error: unknown, verifiedEffectCount: number): string {
  const failure = error instanceof ProviderCallError ? error.details : undefined;
  const reason = failure?.kind === "transient"
    ? `The ${failure.provider} provider remained unavailable after one retry.`
    : failure?.kind === "permanent"
      ? `The ${failure.provider} provider rejected the request, so retrying it would not help; check its account, API key, model, and request configuration.`
      : failure?.kind === "cancelled"
        ? `The ${failure.provider} provider request was cancelled and was not retried.`
        : failure
          ? `The ${failure.provider} provider returned an unclassified error and was not retried.`
          : "The failure was not safe to retry automatically.";
  const effects = verifiedEffectCount > 0
    ? `I preserved ${verifiedEffectCount} verified filesystem ${verifiedEffectCount === 1 ? "change" : "changes"}; the remaining work can continue in a new message.`
    : "No new filesystem change was verified, and the request can be retried in a new message.";
  return `I could not continue because the decision provider or runtime failed. ${reason} ${effects}`;
}
