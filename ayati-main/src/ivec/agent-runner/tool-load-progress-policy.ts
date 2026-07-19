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
    ?? "Repeated tool-loading requests did not make a usable capability available.";
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
        "Use a tool that is already visible instead of requesting the same capability again.",
        "For a user-provided path before binding, use the durable resource inspector exposed during routing and then activate or create its workstream.",
        "After workstream binding, make a fresh decision before requesting or calling mutation tools.",
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
    return `Repeated tool loading made no progress because ${repeated.join(", ")} requires workstream binding. For a user-provided path, use the durable resource inspector exposed during routing; otherwise activate or create the owning workstream. Make a fresh mutation decision after binding.`;
  }
  if (result.unavailable.some((entry) => entry.reason === "not_available_after_workstream_binding")) {
    return `Repeated tool loading made no progress because ${repeated.join(", ")} is not available after workstream binding. Continue with the normal bound-workstream capabilities instead of loading routing controls again.`;
  }
  if (result.alreadyActive.length > 0) {
    return `Repeated tool loading made no progress because ${repeated.join(", ")} was already active. Call the active tool directly instead of loading it again.`;
  }
  return `Repeated tool loading made no progress for ${repeated.join(", ")}. Use an already visible tool or stop with a truthful failure instead of repeating the load request.`;
}

function displayTarget(target: string): string {
  const separator = target.indexOf(":");
  return separator >= 0 ? target.slice(separator + 1) : target;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
