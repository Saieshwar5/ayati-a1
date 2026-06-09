export type RunMetricKind = "llm" | "tool" | "local";
export type RunMetricStatus = "success" | "failed";

export interface RunStageMetric {
  calls: number;
  failures: number;
  totalMs: number;
  maxMs: number;
}

export interface RunMetrics {
  startedAtMs: number;
  llmCalls: number;
  toolCalls: number;
  localDecisions: number;
  stages: Record<string, RunStageMetric>;
}

export function createRunMetrics(): RunMetrics {
  return {
    startedAtMs: Date.now(),
    llmCalls: 0,
    toolCalls: 0,
    localDecisions: 0,
    stages: {},
  };
}

export function recordRunMetric(
  metrics: RunMetrics | undefined,
  stage: string,
  input: {
    durationMs?: number;
    kind?: RunMetricKind;
    status?: RunMetricStatus;
  } = {},
): void {
  if (!metrics) {
    return;
  }

  const durationMs = Math.max(0, Math.round(input.durationMs ?? 0));
  const existing = metrics.stages[stage] ?? {
    calls: 0,
    failures: 0,
    totalMs: 0,
    maxMs: 0,
  };

  existing.calls++;
  existing.totalMs += durationMs;
  existing.maxMs = Math.max(existing.maxMs, durationMs);
  if (input.status === "failed") {
    existing.failures++;
  }
  metrics.stages[stage] = existing;

  switch (input.kind) {
    case "llm":
      metrics.llmCalls++;
      break;
    case "tool":
      metrics.toolCalls++;
      break;
    case "local":
      metrics.localDecisions++;
      break;
  }
}

export function formatRunMetrics(metrics: RunMetrics): string {
  const totalMs = Math.max(0, Date.now() - metrics.startedAtMs);
  const stageSummary = Object.entries(metrics.stages)
    .sort(([, left], [, right]) => right.totalMs - left.totalMs)
    .map(([stage, value]) => {
      const failureSuffix = value.failures > 0 ? ` failed=${value.failures}` : "";
      return `${stage}:calls=${value.calls} total=${value.totalMs}ms max=${value.maxMs}ms${failureSuffix}`;
    })
    .join(" | ");

  return `total=${totalMs}ms llm_calls=${metrics.llmCalls} tool_calls=${metrics.toolCalls} local_decisions=${metrics.localDecisions}${stageSummary ? ` | ${stageSummary}` : ""}`;
}
