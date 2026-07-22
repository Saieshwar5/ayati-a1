import type { FinalizeRunResponse } from "ayati-context-engine";
import type { AgentLoopResult } from "../ivec/types.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "./context-engine-runtime.js";
import { buildAgentRunFinalizationProjection } from "./run-finalization-projection.js";
import { getActiveEvaluationRecorder } from "../evaluation/capture-runtime.js";

export async function finalizeAgentRun(input: {
  runtime: ContextEngineRuntime;
  turn: ContextEnginePreparedTurn;
  result: AgentLoopResult;
  at: string;
  fallbackSummary?: string;
}): Promise<FinalizeRunResponse> {
  const started = process.hrtime.bigint();
  const workstreamBound = isWorkstreamBoundRun(input.turn, input.result);
  const projection = buildAgentRunFinalizationProjection({
    result: input.result,
    workstreamBound,
    ...(input.fallbackSummary ? { fallbackSummary: input.fallbackSummary } : {}),
  });
  let finalized: FinalizeRunResponse | null;
  try {
    finalized = await input.runtime.finalizeRun({
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
  } catch (error) {
    getActiveEvaluationRecorder()?.record({
      sessionId: input.turn.streamId,
      runId: input.turn.run.runId,
      stage: "finalization",
      event: "failed",
      data: { error, durationMs: elapsedMs(started) },
    });
    throw error;
  }
  if (!finalized) {
    throw new Error("Run finalization returned no acknowledgement.");
  }
  getActiveEvaluationRecorder()?.record({
    sessionId: input.turn.streamId,
    runId: input.turn.run.runId,
    stage: "finalization",
    event: "completed",
    data: { durationMs: elapsedMs(started), acknowledgement: finalized },
  });
  return finalized;
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
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
