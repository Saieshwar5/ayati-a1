import type { FinalizeRunResponse } from "ayati-git-context";
import type { AgentLoopResult } from "../ivec/types.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "./git-context-runtime.js";
import { buildAgentRunFinalizationProjection } from "./run-finalization-projection.js";

export async function finalizeAgentRun(input: {
  runtime: GitContextRuntime;
  turn: GitContextPreparedTurn;
  result: AgentLoopResult;
  at: string;
  fallbackSummary?: string;
}): Promise<FinalizeRunResponse> {
  const workstreamBound = isWorkstreamBoundRun(input.turn, input.result);
  const projection = buildAgentRunFinalizationProjection({
    result: input.result,
    workstreamBound,
    ...(input.fallbackSummary ? { fallbackSummary: input.fallbackSummary } : {}),
  });
  const finalized = await input.runtime.finalizeRun({
    turn: input.turn,
    outcome: input.result.outcome,
    stopReason: input.result.stopReason,
    assistantResponse: projection.assistantResponse,
    conversationSummary: projection.conversationSummary,
    summary: projection.summary,
    validation: finalizationValidation(input.result, workstreamBound),
    ...(projection.next ? { next: projection.next } : {}),
    workState: projection.workState,
    ...(projection.workstreamCompletion
      ? { workstreamCompletion: projection.workstreamCompletion }
      : {}),
    at: input.at,
  });
  if (!finalized) {
    throw new Error("Run finalization returned no acknowledgement.");
  }
  return finalized;
}

export function isWorkstreamBoundRun(
  turn: GitContextPreparedTurn,
  result: AgentLoopResult,
): boolean {
  return isWorkstreamBoundResult(result)
    || turn.context.pendingTurn?.routingStatus === "bound";
}

export function isWorkstreamBoundResult(result: AgentLoopResult): boolean {
  return result.harnessContext?.contextEngine?.pendingTurn?.routingStatus === "bound";
}

function finalizationValidation(
  result: AgentLoopResult,
  workstreamBound: boolean,
): "passed" | "failed" | "not_applicable" {
  if (workstreamBound && result.outcome === "done") return "passed";
  if (result.outcome === "failed") return "failed";
  return "not_applicable";
}
