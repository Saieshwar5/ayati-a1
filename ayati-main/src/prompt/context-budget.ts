import type { ResolvedModelContextLimits } from "../providers/shared/model-context-limits.js";

export type ContextPressureLevel = "normal" | "elevated" | "high" | "overflow";

export interface ContextBudget {
  contextWindowTokens: number;
  maxInputTokens?: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
}

export interface ContextBudgetReport extends ContextBudget {
  provider: string;
  model: string;
  limitSource: ResolvedModelContextLimits["source"];
  localEstimateTokens: number;
  correctedLocalEstimateTokens: number;
  providerCountTokens?: number;
  providerCountExact?: boolean;
  providerCountStatus: "not_needed" | "unavailable" | "succeeded" | "failed";
  measuredInputTokens: number;
  countSource: "local_estimate" | "provider_count";
  pressure: number;
  pressureLevel: ContextPressureLevel;
  overBudget: boolean;
}

const SAFETY_MARGIN_RATIO = 0.05;
const MIN_SAFETY_MARGIN_TOKENS = 4_096;
const MAX_SAFETY_MARGIN_TOKENS = 16_384;
const ELEVATED_PRESSURE = 0.7;
const HIGH_PRESSURE = 0.85;

export function calculateContextBudget(limits: ResolvedModelContextLimits): ContextBudget {
  const safetyMarginTokens = Math.min(
    MAX_SAFETY_MARGIN_TOKENS,
    Math.max(MIN_SAFETY_MARGIN_TOKENS, Math.ceil(limits.contextWindowTokens * SAFETY_MARGIN_RATIO)),
  );
  const windowInputLimit = Math.max(
    1,
    limits.contextWindowTokens - limits.outputReserveTokens - safetyMarginTokens,
  );
  const usableInputTokens = limits.maxInputTokens === undefined
    ? windowInputLimit
    : Math.max(1, Math.min(windowInputLimit, limits.maxInputTokens));

  return {
    contextWindowTokens: limits.contextWindowTokens,
    ...(limits.maxInputTokens !== undefined ? { maxInputTokens: limits.maxInputTokens } : {}),
    outputReserveTokens: limits.outputReserveTokens,
    safetyMarginTokens,
    usableInputTokens,
  };
}

export function contextPressureLevel(pressure: number): ContextPressureLevel {
  if (pressure >= 1) return "overflow";
  if (pressure >= HIGH_PRESSURE) return "high";
  if (pressure >= ELEVATED_PRESSURE) return "elevated";
  return "normal";
}

export function roundContextPressure(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
