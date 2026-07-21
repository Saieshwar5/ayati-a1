import type { RunMetrics } from "../metrics.js";
import {
  recordOptimizationEvent,
  recordProviderUsageMetric,
  recordRunMetric,
} from "../metrics.js";
import type { DecisionContextCompilation } from "./decision-context-compiler.js";

export function recordStreamCheckpointObservability(input: {
  compilation: DecisionContextCompilation;
  decisionAttempt: number;
  metrics?: RunMetrics;
  recordFeedback: (event: string, data: Record<string, unknown>) => void;
}): void {
  const checkpoint = input.compilation.streamCheckpoint;
  if (!checkpoint) return;

  const generation = checkpoint.generation;
  const committed = checkpoint.checkpoint;
  const eventData = {
    planId: checkpoint.plan.planId,
    streamId: checkpoint.plan.streamId,
    triggered: checkpoint.plan.triggered,
    selectedMessageCount: checkpoint.plan.selectedMessages.length,
    exactTailCount: checkpoint.plan.exactTail.length,
    estimatedCheckpointTokens: checkpoint.plan.estimatedCheckpointTokens,
    ...(checkpoint.plan.coveredFromSeq !== undefined
      ? { coveredFromSeq: checkpoint.plan.coveredFromSeq }
      : {}),
    ...(checkpoint.plan.coveredToSeq !== undefined
      ? { coveredToSeq: checkpoint.plan.coveredToSeq }
      : {}),
    ...(checkpoint.plan.previousCheckpoint ? {
      previousCheckpointId: checkpoint.plan.previousCheckpoint.checkpointId,
      previousCoveredToSeq: checkpoint.plan.previousCheckpoint.coveredToSeq,
    } : {}),
    status: generation?.status ?? "not_generated",
    generationAttempts: generation?.attempts.length ?? 0,
    ...(generation?.tokenCount !== undefined ? { checkpointTokens: generation.tokenCount } : {}),
    errors: generation?.errors.slice(0, 8) ?? [],
    ...(committed ? { checkpointId: committed.checkpointId, committed: true } : {}),
  };
  recordOptimizationEvent(input.metrics, "stream_checkpoint", eventData);
  input.recordFeedback("stream_checkpoint", eventData);

  for (const attempt of generation?.attempts ?? []) {
    recordRunMetric(input.metrics, "context_stream_checkpoint", {
      durationMs: attempt.durationMs,
      kind: "llm",
      status: attempt.status,
    });
    recordProviderUsageMetric(
      input.metrics,
      "context_stream_checkpoint",
      attempt.usage,
      attempt.cost,
    );
  }

  if (input.compilation.receipt.mode !== "stream_checkpoint") return;
  const budgetData = {
    phase: "intermediate",
    decisionAttempt: input.decisionAttempt,
    ...input.compilation.intermediateBudget,
  };
  recordOptimizationEvent(input.metrics, "context_budget_intermediate", budgetData);
  input.recordFeedback("context_budget_intermediate", budgetData);
}
