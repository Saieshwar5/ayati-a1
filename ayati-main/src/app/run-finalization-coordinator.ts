import type { FinalizeRunResponse } from "ayati-context-engine";
import type { AgentLoopResult } from "../ivec/types.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "./context-engine-runtime.js";
import { buildAgentRunFinalizationProjection } from "./run-finalization-projection.js";

export async function finalizeAgentRun(input: {
  runtime: ContextEngineRuntime;
  turn: ContextEnginePreparedTurn;
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
    streamSummary: projection.streamSummary,
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
  turn: ContextEnginePreparedTurn,
  result: AgentLoopResult,
): boolean {
  return isWorkstreamBoundResult(result)
    || turn.context.current.routing?.status === "bound";
}

export function isWorkstreamBoundResult(result: AgentLoopResult): boolean {
  return result.harnessContext?.contextEngine?.current.routing?.status === "bound";
}

function finalizationValidation(
  result: AgentLoopResult,
  workstreamBound: boolean,
): "passed" | "failed" | "not_applicable" {
  if (workstreamBound && result.outcome === "done") return "passed";
  if (result.outcome === "failed") return "failed";
  return "not_applicable";
}
