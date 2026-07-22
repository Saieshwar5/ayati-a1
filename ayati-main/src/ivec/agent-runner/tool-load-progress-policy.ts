import type { FailureRecord } from "../types.js";
import type { ToolLoadResult } from "./tool-working-set.js";

const REPEATED_NO_PROGRESS_LIMIT = 2;

export interface ToolLoadProgressState {
  attemptsByTarget: Record<string, number>;
}

export interface ToolLoadProgressEvaluation {
  state: ToolLoadProgressState;
  madeProgress: boolean;
  shouldStop: boolean;
  repeatedTargets: string[];
  message?: string;
}

export function createToolLoadProgressState(): ToolLoadProgressState {
  return { attemptsByTarget: {} };
}

export function evaluateToolLoadProgress(
  previous: ToolLoadProgressState,
  result: ToolLoadResult,
): ToolLoadProgressEvaluation {
  if (result.loaded.length > 0) {
    return {
      state: createToolLoadProgressState(),
      madeProgress: true,
      shouldStop: false,
      repeatedTargets: [],
    };
  }

  const targets = noProgressTargets(result);
  const attemptsByTarget = { ...previous.attemptsByTarget };
  for (const target of targets) {
    attemptsByTarget[target] = (attemptsByTarget[target] ?? 0) + 1;
  }
  const repeatedTargets = targets.filter(
    (target) => (attemptsByTarget[target] ?? 0) >= REPEATED_NO_PROGRESS_LIMIT,
  );
  const shouldStop = repeatedTargets.length > 0;
  return {
    state: { attemptsByTarget },
    madeProgress: false,
    shouldStop,
    repeatedTargets: repeatedTargets.map(displayTarget),
    ...(shouldStop ? { message: buildNoProgressMessage(result, repeatedTargets) } : {}),
  };
}

export function createToolLoadNoProgressFailure(
  evaluation: ToolLoadProgressEvaluation,
  step: number,
): FailureRecord {
  const reason = evaluation.message
    ?? "Repeated mode transitions did not make a usable capability available.";
  return {
    step,
    failureType: "no_progress",
    reason,
    blockedTargets: evaluation.repeatedTargets,
    repairCode: "R_NO_PROGRESS",
    repair: {
      code: "R_NO_PROGRESS",
      message: reason,
      blockedTargets: evaluation.repeatedTargets,
      allowedNextActions: [
        "Use a tool that is already visible instead of repeating the same mode transition.",
        "For a binding-required capability, submit one evidence-backed proposal to the deterministic resolve gate before making a fresh decision.",
        "After workstream binding, make a fresh decision before calling mutation tools.",
      ],
    },
  };
}

function noProgressTargets(result: ToolLoadResult): string[] {
  if (result.unavailable.length > 0) {
    return uniqueStrings(result.unavailable.map((entry) => `unavailable:${entry.tool}`));
  }
  if (result.alreadyActive.length > 0) {
    return uniqueStrings(result.alreadyActive.map((tool) => `already_active:${tool}`));
  }
  if (result.missing.length > 0) {
    return uniqueStrings(result.missing.map((selector) => `missing:${selector}`));
  }
  return [`status:${result.status}`];
}

function buildNoProgressMessage(
  result: ToolLoadResult,
  repeatedTargets: string[],
): string {
  const repeated = repeatedTargets.map(displayTarget);
  if (result.unavailable.some((entry) => entry.reason === "requires_workstream_binding")) {
    return `Repeated capability transitions made no progress because ${repeated.join(", ")} requires workstream binding. Submit one evidence-backed proposal to the deterministic resolve gate, then make a fresh mutation decision only after authoritative bound context is mounted.`;
  }
  if (result.unavailable.some((entry) => entry.reason === "not_available_after_workstream_binding")) {
    return `Repeated capability transitions made no progress because ${repeated.join(", ")} is not available after workstream binding. Continue with the bound execute capabilities instead of requesting routing controls again.`;
  }
  if (result.alreadyActive.length > 0) {
    return `Repeated mode transitions made no progress because ${repeated.join(", ")} was already active. Call the active tool directly instead of repeating the transition.`;
  }
  return `Repeated mode transitions made no progress for ${repeated.join(", ")}. Use an already visible tool or validate a truthful terminal outcome instead of repeating the request.`;
}

function displayTarget(target: string): string {
  const separator = target.indexOf(":");
  return separator >= 0 ? target.slice(separator + 1) : target;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
