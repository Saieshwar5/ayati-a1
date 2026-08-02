import type { VerifiedFilesystemResourceEffect } from "ayati-context-engine";
import { compactText, compactWorkState } from "../state-compaction.js";
import type { LoopState, StepSummary, WorkState } from "../types.js";
import { buildVerifiedResourceEffects } from "./verified-resource-effects.js";

const MAX_RESPONSE_ITEMS = 4;

export interface RunLimitHandoff {
  response: string;
  workState: WorkState;
  verifiedEffectCount: number;
  verifiedStepCount: number;
  bound: boolean;
  requestId?: string;
}

/**
 * Close an exhausted run from exact runtime evidence without another model
 * call. This is a partial-progress handoff, not task-completion validation.
 */
export function buildRunLimitHandoff(
  state: LoopState,
  maxIterations: number,
): RunLimitHandoff {
  const effects = buildVerifiedResourceEffects(state);
  const verifiedSteps = state.completedSteps.filter(isVerifiedSuccessfulStep);
  const routing = state.harnessContext.contextEngine?.current.routing;
  const bound = routing?.status === "bound";
  const requestId = bound ? routing.requestId : undefined;
  const selectedRequest = bound
    ? state.harnessContext.contextEngine?.workstream?.selectedRequest
      ?? state.harnessContext.contextEngine?.workstream?.currentRequest
    : undefined;
  const pending = pendingWork(state, selectedRequest?.request);
  const nextAction = state.workState.nextAction?.trim()
    || pending[0]
    || selectedRequest?.request?.trim()
    || state.userMessage.trim()
    || "Continue from the latest verified state.";
  const summary = handoffSummary(effects.length, verifiedSteps.length);
  const workState = compactWorkState({
    ...state.workState,
    status: "in_progress",
    summary,
    plan: state.workState.plan.map((item) => ({
      ...item,
      status: item.status === "active" ? "pending" : item.status,
    })),
    importantContext: appendEffectEvidence(
      state.workState.importantContext,
      effects,
      state.runId,
    ),
    nextAction,
  });
  const completed = completedWork(effects, verifiedSteps);

  return {
    response: buildResponse({
      maxIterations,
      completed,
      pending,
      nextAction,
      bound,
      requestId,
    }),
    workState,
    verifiedEffectCount: effects.length,
    verifiedStepCount: verifiedSteps.length,
    bound,
    ...(requestId ? { requestId } : {}),
  };
}

function isVerifiedSuccessfulStep(step: StepSummary): boolean {
  return step.toolSuccessCount > 0
    && step.toolFailureCount === 0
    && step.outcome !== "failed"
    && step.validationStatus === "passed";
}

function completedWork(
  effects: VerifiedFilesystemResourceEffect[],
  verifiedSteps: StepSummary[],
): string[] {
  if (effects.length > 0) {
    return effects.slice(-MAX_RESPONSE_ITEMS).map(effectDescription);
  }
  return verifiedSteps
    .slice(-MAX_RESPONSE_ITEMS)
    .map((step) => compactText(
      step.evidenceSummary || step.summary,
      240,
    ))
    .filter(Boolean);
}

function pendingWork(
  state: LoopState,
  selectedRequest: string | undefined,
): string[] {
  const planItems = state.workState.plan
    .filter((item) => item.status !== "done")
    .map((item) => item.task.trim())
    .filter(Boolean);
  if (planItems.length > 0) return unique(planItems).slice(0, MAX_RESPONSE_ITEMS);
  if (state.workState.nextAction?.trim()) return [state.workState.nextAction.trim()];
  if (selectedRequest?.trim()) return [selectedRequest.trim()];
  return state.userMessage.trim() ? [state.userMessage.trim()] : [];
}

function handoffSummary(effectCount: number, verifiedStepCount: number): string {
  if (effectCount > 0) {
    return `Run paused at the decision limit after preserving ${effectCount} verified resource ${effectCount === 1 ? "effect" : "effects"}.`;
  }
  if (verifiedStepCount > 0) {
    return `Run paused at the decision limit after ${verifiedStepCount} verified task ${verifiedStepCount === 1 ? "step" : "steps"}; no verified filesystem change was recorded.`;
  }
  return "Run paused at the decision limit before any task action was durably verified.";
}

function appendEffectEvidence(
  existing: WorkState["importantContext"],
  effects: VerifiedFilesystemResourceEffect[],
  runId: string,
): WorkState["importantContext"] {
  const additions: WorkState["importantContext"] = effects
    .slice(-6)
    .map((effect) => ({
      kind: "artifact" as const,
      value: effectDescription(effect),
      ref: effect.evidenceRef
        || `run:${runId}:step:${effect.step}${effect.callId ? `:call:${effect.callId}` : ""}`,
    }));
  return uniqueContext([...existing, ...additions]).slice(-12);
}

function buildResponse(input: {
  maxIterations: number;
  completed: string[];
  pending: string[];
  nextAction: string;
  bound: boolean;
  requestId?: string;
}): string {
  const sections = [
    `I reached the ${input.maxIterations}-decision limit and safely paused this run.`,
    input.completed.length > 0
      ? `Completed and verified:\n${bullets(input.completed)}`
      : "Completed and verified: No task action was durably verified in this run.",
    input.pending.length > 0
      ? `Still pending:\n${bullets(input.pending)}`
      : "Still pending: Continue the original request from the latest verified state.",
    input.bound
      ? `Request ${input.requestId ?? "the selected request"} remains active.`
      : "No workstream or request was created or activated in this run.",
    `Next: ${compactText(input.nextAction, 320)}`,
  ];
  return sections.join("\n\n");
}

function effectDescription(effect: VerifiedFilesystemResourceEffect): string {
  const operation = effect.operation.replaceAll("_", " ");
  const target = effect.operation === "copied" || effect.operation === "moved"
    ? `${effect.sourcePath} -> ${effect.destinationPath}`
    : effect.path;
  return `${capitalize(operation)} ${target}.`;
}

function bullets(values: string[]): string {
  return values.map((value) => `- ${compactText(value, 320)}`).join("\n");
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueContext(
  values: WorkState["importantContext"],
): WorkState["importantContext"] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.kind}\u0000${item.value.trim()}\u0000${item.ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
