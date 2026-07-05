import type { LlmCostEstimate, LlmTokenUsage } from "../core/contracts/llm-protocol.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";

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
  totalEstimatedTokens: number;
  maxEstimatedTokens: number;
  sectionTotals: Record<string, number>;
  sectionMax: Record<string, number>;
  sectionTokenTotals: Record<string, number>;
  sectionTokenMax: Record<string, number>;
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

export interface ProviderUsageMetricSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  estimatedCostUsd: number;
  byModel: Record<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    estimatedCostUsd: number;
  }>;
}

export interface ContextGrowthPoint {
  call: number;
  totalChars: number;
  totalEstimatedTokens: number;
  deltaChars: number;
  deltaEstimatedTokens: number;
  sections: Record<string, number>;
  sectionEstimatedTokens: Record<string, number>;
  sectionDeltas: Record<string, number>;
  sectionTokenDeltas: Record<string, number>;
  stateBreakdown?: Record<string, number>;
  stateBreakdownEstimatedTokens?: Record<string, number>;
  stateBreakdownDeltas?: Record<string, number>;
  stateBreakdownTokenDeltas?: Record<string, number>;
}

export interface ContextGrowthMetricSummary {
  calls: number;
  firstChars: number;
  latestChars: number;
  maxChars: number;
  totalPositiveDeltaChars: number;
  maxDeltaChars: number;
  firstEstimatedTokens: number;
  latestEstimatedTokens: number;
  maxEstimatedTokens: number;
  totalPositiveDeltaEstimatedTokens: number;
  maxDeltaEstimatedTokens: number;
  sectionPositiveDeltaChars: Record<string, number>;
  sectionMaxDeltaChars: Record<string, number>;
  sectionPositiveDeltaEstimatedTokens: Record<string, number>;
  sectionMaxDeltaEstimatedTokens: Record<string, number>;
  stateBreakdownPositiveDeltaChars: Record<string, number>;
  stateBreakdownMaxDeltaChars: Record<string, number>;
  stateBreakdownPositiveDeltaEstimatedTokens: Record<string, number>;
  stateBreakdownMaxDeltaEstimatedTokens: Record<string, number>;
  points: ContextGrowthPoint[];
}

export interface OptimizationMetricsSummary {
  prompts: Record<string, PromptMetricSummary>;
  compactions: Record<string, CompactionMetricSummary>;
  stateSizes: Record<string, StateSizeMetricSummary>;
  providerUsage: Record<string, ProviderUsageMetricSummary>;
  contextGrowth: Record<string, ContextGrowthMetricSummary>;
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
  promptGrowthState: Record<string, {
    totalChars: number;
    totalEstimatedTokens: number;
    sections: Record<string, number>;
    sectionEstimatedTokens: Record<string, number>;
    stateBreakdown?: Record<string, number>;
    stateBreakdownEstimatedTokens?: Record<string, number>;
  }>;
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
      providerUsage: {},
      contextGrowth: {},
      planModes: {},
      verificationMethods: {},
      warnings: [],
    },
    promptGrowthState: {},
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
  options: {
    stateBreakdown?: Record<string, string | number | undefined>;
  } = {},
): void {
  if (!metrics) {
    return;
  }

  const measuredSections = measureSections(sections);
  const totalChars = Object.values(measuredSections.chars).reduce((sum, value) => sum + value, 0);
  const totalEstimatedTokens = Object.values(measuredSections.tokens).reduce((sum, value) => sum + value, 0);
  const existing = metrics.optimization.prompts[stage] ?? {
    calls: 0,
    totalChars: 0,
    maxChars: 0,
    totalEstimatedTokens: 0,
    maxEstimatedTokens: 0,
    sectionTotals: {},
    sectionMax: {},
    sectionTokenTotals: {},
    sectionTokenMax: {},
  };
  existing.calls++;
  existing.totalChars += totalChars;
  existing.maxChars = Math.max(existing.maxChars, totalChars);
  existing.totalEstimatedTokens += totalEstimatedTokens;
  existing.maxEstimatedTokens = Math.max(existing.maxEstimatedTokens, totalEstimatedTokens);
  for (const [section, chars] of Object.entries(measuredSections.chars)) {
    existing.sectionTotals[section] = (existing.sectionTotals[section] ?? 0) + chars;
    existing.sectionMax[section] = Math.max(existing.sectionMax[section] ?? 0, chars);
  }
  for (const [section, tokens] of Object.entries(measuredSections.tokens)) {
    existing.sectionTokenTotals[section] = (existing.sectionTokenTotals[section] ?? 0) + tokens;
    existing.sectionTokenMax[section] = Math.max(existing.sectionTokenMax[section] ?? 0, tokens);
  }
  metrics.optimization.prompts[stage] = existing;
  const measuredStateBreakdown = options.stateBreakdown ? measureSections(options.stateBreakdown) : undefined;
  recordContextGrowthMetric(metrics, stage, {
    totalChars,
    totalEstimatedTokens,
    sections: measuredSections.chars,
    sectionEstimatedTokens: measuredSections.tokens,
    ...(measuredStateBreakdown ? {
      stateBreakdown: measuredStateBreakdown.chars,
      stateBreakdownEstimatedTokens: measuredStateBreakdown.tokens,
    } : {}),
  });
  recordOptimizationEvent(metrics, "prompt", {
    stage,
    totalChars,
    totalEstimatedTokens,
    sections: measuredSections.chars,
    sectionEstimatedTokens: measuredSections.tokens,
  });
}

export function recordContextGrowthMetric(
  metrics: RunMetrics | undefined,
  stage: string,
  measurement: {
    totalChars: number;
    totalEstimatedTokens: number;
    sections: Record<string, number>;
    sectionEstimatedTokens: Record<string, number>;
    stateBreakdown?: Record<string, number>;
    stateBreakdownEstimatedTokens?: Record<string, number>;
  },
): void {
  if (!metrics) {
    return;
  }
  const previous = metrics.promptGrowthState[stage];
  const deltaChars = previous ? measurement.totalChars - previous.totalChars : 0;
  const deltaEstimatedTokens = previous ? measurement.totalEstimatedTokens - previous.totalEstimatedTokens : 0;
  const sectionDeltas = diffNumberRecords(measurement.sections, previous?.sections);
  const sectionTokenDeltas = diffNumberRecords(measurement.sectionEstimatedTokens, previous?.sectionEstimatedTokens);
  const stateBreakdownDeltas = measurement.stateBreakdown
    ? diffNumberRecords(measurement.stateBreakdown, previous?.stateBreakdown)
    : undefined;
  const stateBreakdownTokenDeltas = measurement.stateBreakdownEstimatedTokens
    ? diffNumberRecords(measurement.stateBreakdownEstimatedTokens, previous?.stateBreakdownEstimatedTokens)
    : undefined;

  const existing = metrics.optimization.contextGrowth[stage] ?? {
    calls: 0,
    firstChars: measurement.totalChars,
    latestChars: 0,
    maxChars: 0,
    totalPositiveDeltaChars: 0,
    maxDeltaChars: 0,
    firstEstimatedTokens: measurement.totalEstimatedTokens,
    latestEstimatedTokens: 0,
    maxEstimatedTokens: 0,
    totalPositiveDeltaEstimatedTokens: 0,
    maxDeltaEstimatedTokens: 0,
    sectionPositiveDeltaChars: {},
    sectionMaxDeltaChars: {},
    sectionPositiveDeltaEstimatedTokens: {},
    sectionMaxDeltaEstimatedTokens: {},
    stateBreakdownPositiveDeltaChars: {},
    stateBreakdownMaxDeltaChars: {},
    stateBreakdownPositiveDeltaEstimatedTokens: {},
    stateBreakdownMaxDeltaEstimatedTokens: {},
    points: [],
  };

  existing.calls++;
  existing.latestChars = measurement.totalChars;
  existing.maxChars = Math.max(existing.maxChars, measurement.totalChars);
  existing.totalPositiveDeltaChars += Math.max(0, deltaChars);
  existing.maxDeltaChars = Math.max(existing.maxDeltaChars, deltaChars);
  existing.latestEstimatedTokens = measurement.totalEstimatedTokens;
  existing.maxEstimatedTokens = Math.max(existing.maxEstimatedTokens, measurement.totalEstimatedTokens);
  existing.totalPositiveDeltaEstimatedTokens += Math.max(0, deltaEstimatedTokens);
  existing.maxDeltaEstimatedTokens = Math.max(existing.maxDeltaEstimatedTokens, deltaEstimatedTokens);
  accumulatePositiveDeltas(existing.sectionPositiveDeltaChars, existing.sectionMaxDeltaChars, sectionDeltas);
  accumulatePositiveDeltas(
    existing.sectionPositiveDeltaEstimatedTokens,
    existing.sectionMaxDeltaEstimatedTokens,
    sectionTokenDeltas,
  );
  if (stateBreakdownDeltas) {
    accumulatePositiveDeltas(existing.stateBreakdownPositiveDeltaChars, existing.stateBreakdownMaxDeltaChars, stateBreakdownDeltas);
  }
  if (stateBreakdownTokenDeltas) {
    accumulatePositiveDeltas(
      existing.stateBreakdownPositiveDeltaEstimatedTokens,
      existing.stateBreakdownMaxDeltaEstimatedTokens,
      stateBreakdownTokenDeltas,
    );
  }

  const point: ContextGrowthPoint = {
    call: existing.calls,
    totalChars: measurement.totalChars,
    totalEstimatedTokens: measurement.totalEstimatedTokens,
    deltaChars,
    deltaEstimatedTokens,
    sections: measurement.sections,
    sectionEstimatedTokens: measurement.sectionEstimatedTokens,
    sectionDeltas,
    sectionTokenDeltas,
    ...(measurement.stateBreakdown ? { stateBreakdown: measurement.stateBreakdown } : {}),
    ...(measurement.stateBreakdownEstimatedTokens ? { stateBreakdownEstimatedTokens: measurement.stateBreakdownEstimatedTokens } : {}),
    ...(stateBreakdownDeltas ? { stateBreakdownDeltas } : {}),
    ...(stateBreakdownTokenDeltas ? { stateBreakdownTokenDeltas } : {}),
  };
  existing.points.push(point);
  metrics.optimization.contextGrowth[stage] = existing;
  metrics.promptGrowthState[stage] = {
    totalChars: measurement.totalChars,
    totalEstimatedTokens: measurement.totalEstimatedTokens,
    sections: measurement.sections,
    sectionEstimatedTokens: measurement.sectionEstimatedTokens,
    ...(measurement.stateBreakdown ? { stateBreakdown: measurement.stateBreakdown } : {}),
    ...(measurement.stateBreakdownEstimatedTokens ? { stateBreakdownEstimatedTokens: measurement.stateBreakdownEstimatedTokens } : {}),
  };
  recordOptimizationEvent(metrics, "context_growth", {
    stage,
    ...point,
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

export function recordProviderUsageMetric(
  metrics: RunMetrics | undefined,
  stage: string,
  usage: LlmTokenUsage | undefined,
  cost: LlmCostEstimate | undefined,
): void {
  if (!metrics || !usage) {
    return;
  }
  const cachedInputTokens = Math.max(0, Math.round(usage.cachedInputTokens ?? 0));
  const estimatedCostUsd = roundUsd(cost?.totalCostUsd ?? 0);
  const existing = metrics.optimization.providerUsage[stage] ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
    byModel: {},
  };

  existing.calls++;
  existing.inputTokens += Math.max(0, Math.round(usage.inputTokens));
  existing.outputTokens += Math.max(0, Math.round(usage.outputTokens));
  existing.totalTokens += Math.max(0, Math.round(usage.totalTokens));
  existing.cachedInputTokens += cachedInputTokens;
  existing.estimatedCostUsd = roundUsd(existing.estimatedCostUsd + estimatedCostUsd);

  const modelKey = `${usage.provider}:${usage.model}`;
  const byModel = existing.byModel[modelKey] ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    estimatedCostUsd: 0,
  };
  byModel.calls++;
  byModel.inputTokens += Math.max(0, Math.round(usage.inputTokens));
  byModel.outputTokens += Math.max(0, Math.round(usage.outputTokens));
  byModel.totalTokens += Math.max(0, Math.round(usage.totalTokens));
  byModel.cachedInputTokens += cachedInputTokens;
  byModel.estimatedCostUsd = roundUsd(byModel.estimatedCostUsd + estimatedCostUsd);
  existing.byModel[modelKey] = byModel;

  metrics.optimization.providerUsage[stage] = existing;
  recordOptimizationEvent(metrics, "provider_usage", {
    stage,
    usage,
    ...(cost ? { cost } : {}),
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

function measureSections(sections: Record<string, string | number | undefined>): {
  chars: Record<string, number>;
  tokens: Record<string, number>;
} {
  const chars: Record<string, number> = {};
  const tokens: Record<string, number> = {};
  for (const [key, value] of Object.entries(sections)) {
    if (value === undefined) {
      chars[key] = 0;
      tokens[key] = 0;
    } else if (typeof value === "number") {
      const normalized = Math.max(0, Math.round(value));
      chars[key] = normalized;
      tokens[key] = estimateTextTokens("x".repeat(normalized));
    } else {
      chars[key] = value.length;
      tokens[key] = estimateTextTokens(value);
    }
  }
  return { chars, tokens };
}

function normalizeNumberRecord(input: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[key] = Math.max(0, Math.round(value));
  }
  return normalized;
}

function diffNumberRecords(
  current: Record<string, number>,
  previous: Record<string, number> | undefined,
): Record<string, number> {
  const keys = new Set([...Object.keys(current), ...Object.keys(previous ?? {})]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    out[key] = previous ? Math.round((current[key] ?? 0) - (previous[key] ?? 0)) : 0;
  }
  return out;
}

function accumulatePositiveDeltas(
  positiveTotals: Record<string, number>,
  maxDeltas: Record<string, number>,
  deltas: Record<string, number>,
): void {
  for (const [key, delta] of Object.entries(deltas)) {
    positiveTotals[key] = (positiveTotals[key] ?? 0) + Math.max(0, delta);
    maxDeltas[key] = Math.max(maxDeltas[key] ?? 0, delta);
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
