import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RunMetricKind = "llm" | "tool" | "local";
export type RunMetricStatus = "success" | "failed";

export interface RunStageMetric {
  calls: number;
  failures: number;
  totalMs: number;
  maxMs: number;
}

export interface OptimizationEvent {
  tsMs: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface PromptMetricSummary {
  calls: number;
  totalChars: number;
  maxChars: number;
  sectionTotals: Record<string, number>;
  sectionMax: Record<string, number>;
}

export interface CompactionMetricSummary {
  calls: number;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
}

export interface StateSizeMetricSummary {
  calls: number;
  latest: Record<string, number>;
  max: Record<string, number>;
}

export interface OptimizationMetricsSummary {
  prompts: Record<string, PromptMetricSummary>;
  compactions: Record<string, CompactionMetricSummary>;
  stateSizes: Record<string, StateSizeMetricSummary>;
  planModes: Record<string, number>;
  verificationMethods: Record<string, number>;
  warnings: Array<{ tsMs: number; kind: string; message: string; data?: Record<string, unknown> }>;
}

export interface RunMetrics {
  startedAtMs: number;
  llmCalls: number;
  toolCalls: number;
  localDecisions: number;
  stages: Record<string, RunStageMetric>;
  optimization: OptimizationMetricsSummary;
  optimizationEvents: OptimizationEvent[];
}

export function createRunMetrics(): RunMetrics {
  return {
    startedAtMs: Date.now(),
    llmCalls: 0,
    toolCalls: 0,
    localDecisions: 0,
    stages: {},
    optimization: {
      prompts: {},
      compactions: {},
      stateSizes: {},
      planModes: {},
      verificationMethods: {},
      warnings: [],
    },
    optimizationEvents: [],
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

export function recordPromptMetric(
  metrics: RunMetrics | undefined,
  stage: string,
  sections: Record<string, string | number | undefined>,
): void {
  if (!metrics) {
    return;
  }

  const measuredSections = measureSections(sections);
  const totalChars = Object.values(measuredSections).reduce((sum, value) => sum + value, 0);
  const existing = metrics.optimization.prompts[stage] ?? {
    calls: 0,
    totalChars: 0,
    maxChars: 0,
    sectionTotals: {},
    sectionMax: {},
  };
  existing.calls++;
  existing.totalChars += totalChars;
  existing.maxChars = Math.max(existing.maxChars, totalChars);
  for (const [section, chars] of Object.entries(measuredSections)) {
    existing.sectionTotals[section] = (existing.sectionTotals[section] ?? 0) + chars;
    existing.sectionMax[section] = Math.max(existing.sectionMax[section] ?? 0, chars);
  }
  metrics.optimization.prompts[stage] = existing;
  recordOptimizationEvent(metrics, "prompt", {
    stage,
    totalChars,
    sections: measuredSections,
  });
}

export function recordCompactionMetric(
  metrics: RunMetrics | undefined,
  name: string,
  beforeChars: number,
  afterChars: number,
  data: Record<string, unknown> = {},
): void {
  if (!metrics) {
    return;
  }
  const before = Math.max(0, Math.round(beforeChars));
  const after = Math.max(0, Math.round(afterChars));
  const saved = Math.max(0, before - after);
  const existing = metrics.optimization.compactions[name] ?? {
    calls: 0,
    beforeChars: 0,
    afterChars: 0,
    savedChars: 0,
  };
  existing.calls++;
  existing.beforeChars += before;
  existing.afterChars += after;
  existing.savedChars += saved;
  metrics.optimization.compactions[name] = existing;
  recordOptimizationEvent(metrics, "compaction", {
    name,
    beforeChars: before,
    afterChars: after,
    savedChars: saved,
    ...data,
  });
}

export function recordStateSizeMetric(
  metrics: RunMetrics | undefined,
  label: string,
  sizes: Record<string, number>,
): void {
  if (!metrics) {
    return;
  }
  const normalized = normalizeNumberRecord(sizes);
  const existing = metrics.optimization.stateSizes[label] ?? {
    calls: 0,
    latest: {},
    max: {},
  };
  existing.calls++;
  existing.latest = normalized;
  for (const [key, value] of Object.entries(normalized)) {
    existing.max[key] = Math.max(existing.max[key] ?? 0, value);
  }
  metrics.optimization.stateSizes[label] = existing;
  recordOptimizationEvent(metrics, "state_size", {
    label,
    sizes: normalized,
  });
}

export function recordPlanModeMetric(
  metrics: RunMetrics | undefined,
  mode: string | undefined,
  data: Record<string, unknown> = {},
): void {
  if (!metrics || !mode) {
    return;
  }
  metrics.optimization.planModes[mode] = (metrics.optimization.planModes[mode] ?? 0) + 1;
  recordOptimizationEvent(metrics, "plan_mode", { mode, ...data });
}

export function recordVerificationMetric(
  metrics: RunMetrics | undefined,
  method: string | undefined,
  data: Record<string, unknown> = {},
): void {
  if (!metrics || !method) {
    return;
  }
  metrics.optimization.verificationMethods[method] = (metrics.optimization.verificationMethods[method] ?? 0) + 1;
  recordOptimizationEvent(metrics, "verification", { method, ...data });
}

export function recordOptimizationWarning(
  metrics: RunMetrics | undefined,
  kind: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!metrics) {
    return;
  }
  const warning = { tsMs: Date.now() - metrics.startedAtMs, kind, message, data };
  metrics.optimization.warnings.push(warning);
  recordOptimizationEvent(metrics, "warning", warning);
}

export function recordOptimizationEvent(
  metrics: RunMetrics | undefined,
  kind: string,
  data: Record<string, unknown>,
): void {
  if (!metrics) {
    return;
  }
  metrics.optimizationEvents.push({
    tsMs: Date.now() - metrics.startedAtMs,
    kind,
    data,
  });
}

export async function writeOptimizationMetrics(runPath: string, metrics: RunMetrics): Promise<void> {
  const summaryPath = join(runPath, "optimization-summary.json");
  const eventsPath = join(runPath, "optimization-events.jsonl");
  await Promise.all([
    writeFile(summaryPath, `${JSON.stringify(buildOptimizationSummary(metrics), null, 2)}\n`, "utf-8"),
    writeFile(eventsPath, metrics.optimizationEvents.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8"),
  ]);
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

function buildOptimizationSummary(metrics: RunMetrics): Record<string, unknown> {
  return {
    totalMs: Math.max(0, Date.now() - metrics.startedAtMs),
    llmCalls: metrics.llmCalls,
    toolCalls: metrics.toolCalls,
    localDecisions: metrics.localDecisions,
    stages: metrics.stages,
    optimization: metrics.optimization,
  };
}

function measureSections(sections: Record<string, string | number | undefined>): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const [key, value] of Object.entries(sections)) {
    if (value === undefined) {
      measured[key] = 0;
    } else if (typeof value === "number") {
      measured[key] = Math.max(0, Math.round(value));
    } else {
      measured[key] = value.length;
    }
  }
  return measured;
}

function normalizeNumberRecord(input: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[key] = Math.max(0, Math.round(value));
  }
  return normalized;
}
