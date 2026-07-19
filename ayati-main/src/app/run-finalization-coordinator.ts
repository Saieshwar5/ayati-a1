import type { FinalizeRunResponse, TaskCompletionRecord } from "ayati-git-context";
import type { AgentLoopResult } from "../ivec/types.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "./git-context-runtime.js";

export async function finalizeAgentRun(input: {
  runtime: GitContextRuntime;
  turn: GitContextPreparedTurn;
  result: AgentLoopResult;
  at: string;
  fallbackSummary?: string;
}): Promise<FinalizeRunResponse> {
  const taskBound = isTaskBoundRun(input.turn, input.result);
  const finalized = await input.runtime.finalizeRun({
    turn: input.turn,
    outcome: input.result.outcome,
    stopReason: input.result.stopReason,
    assistantResponse: input.result.content,
    conversationSummary: input.result.taskSummary?.summary ?? input.result.content,
    summary: input.result.workState?.summary
      || input.result.content
      || input.fallbackSummary
      || "Run finalized.",
    validation: finalizationValidation(input.result, taskBound),
    ...(input.result.workState?.nextStep ? { next: input.result.workState.nextStep } : {}),
    workState: input.result.workState,
    ...(taskBound ? { taskCompletion: taskCompletionFromResult(input.result) } : {}),
    at: input.at,
  });
  if (!finalized) {
    throw new Error("Run finalization returned no acknowledgement.");
  }
  return finalized;
}

export function isTaskBoundRun(
  turn: GitContextPreparedTurn,
  result: AgentLoopResult,
): boolean {
  return isTaskBoundResult(result)
    || turn.context.pendingTurn?.routingStatus === "bound";
}

export function isTaskBoundResult(result: AgentLoopResult): boolean {
  return result.harnessContext?.contextEngine?.pendingTurn?.routingStatus === "bound";
}

function finalizationValidation(
  result: AgentLoopResult,
  taskBound: boolean,
): "passed" | "failed" | "not_applicable" {
  if (taskBound && result.outcome === "done") return "passed";
  if (result.outcome === "failed") return "failed";
  return "not_applicable";
}

function taskCompletionFromResult(result: AgentLoopResult): TaskCompletionRecord {
  const accepted = result.outcome === "done" && result.workState?.status === "done";
  const summary = result.taskSummary?.summary || result.workState?.summary || result.content;
  const assets: TaskCompletionRecord["assets"] = (result.verifiedCompletionAssets ?? []).flatMap(
    (asset) => {
      if (!asset.path || (asset.kind !== "file" && asset.kind !== "directory")) return [];
      return [{
        path: asset.path,
        kind: asset.kind,
        description: asset.description || asset.name,
        verified: true,
      }];
    },
  );
  return {
    accepted,
    assets,
    missing: result.outcome === "done" && !accepted
      ? ["Accepted deterministic task-completion evidence"]
      : [],
    failures: uniqueStrings([
      ...(result.workState?.blockers ?? []),
      result.taskSummary?.failureSummary?.error,
    ]),
    criteria: [{
      criterion: "Complete the active task request with deterministic verification.",
      passed: accepted,
      ...(summary ? { evidence: summary } : {}),
    }],
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0))];
}
