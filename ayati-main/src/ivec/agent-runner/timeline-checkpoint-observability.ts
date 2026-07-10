import type { RunMetrics } from "../metrics.js";
import {
  recordOptimizationEvent,
  recordProviderUsageMetric,
  recordRunMetric,
} from "../metrics.js";
import type { DecisionContextCompilation } from "./decision-context-compiler.js";

export function recordTimelineCheckpointObservability(input: {
  compilation: DecisionContextCompilation;
  decisionAttempt: number;
  metrics?: RunMetrics;
  recordFeedback: (event: string, data: Record<string, unknown>) => void;
}): void {
  const checkpoint = input.compilation.timelineCheckpoint;
  if (!checkpoint) return;

  const {
    selectedEvents,
    exactTail,
    continuityCheckpoint,
    ...planReceipt
  } = checkpoint.plan;
  const generation = checkpoint.generation;
  const eventData = {
    ...planReceipt,
    selectedEventCount: selectedEvents.length,
    exactTailCount: exactTail.length,
    ...(continuityCheckpoint ? {
      continuityCheckpointId: continuityCheckpoint.checkpointId,
      continuityRunId: continuityCheckpoint.runId,
      continuityFromSeq: continuityCheckpoint.fromSeq,
      continuityToSeq: continuityCheckpoint.toSeq,
    } : {}),
    status: generation?.status ?? "not_generated",
    cacheStatus: generation?.cacheStatus,
    generationAttempts: generation?.attempts.length ?? 0,
    checkpointTokens: generation?.checkpointTokens,
    errors: generation?.errors.slice(0, 8) ?? [],
  };
  recordOptimizationEvent(input.metrics, "timeline_checkpoint", eventData);
  input.recordFeedback("timeline_checkpoint", eventData);

  for (const attempt of generation?.attempts ?? []) {
    recordRunMetric(input.metrics, "context_timeline_checkpoint", {
      durationMs: attempt.durationMs,
      kind: "llm",
      status: attempt.status,
    });
    recordProviderUsageMetric(
      input.metrics,
      "context_timeline_checkpoint",
      attempt.usage,
      attempt.cost,
    );
  }

  if (input.compilation.receipt.mode !== "timeline_checkpoint") return;
  const budgetData = {
    phase: "intermediate",
    decisionAttempt: input.decisionAttempt,
    ...input.compilation.intermediateBudget,
  };
  recordOptimizationEvent(input.metrics, "context_budget_intermediate", budgetData);
  input.recordFeedback("context_budget_intermediate", budgetData);
}
