import type { ResolvedModelContextLimits } from "../providers/shared/model-context-limits.js";

export type ContextPressureLevel = "normal" | "elevated" | "high" | "overflow";

export interface ContextBudget {
  contextWindowTokens: number;
  maxInputTokens?: number;
  outputReserveTokens: number;
  inputCapacityTokens: number;
  preparationInputTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
  hardInputTokens: number;
  localAdmissionInputTokens: number;
}

export interface ContextBudgetReport extends ContextBudget {
  provider: string;
  model: string;
  limitSource: ResolvedModelContextLimits["source"];
  localMessageTokens: number;
  localToolSchemaTokens: number;
  localEstimateTokens: number;
  correctedLocalEstimateTokens: number;
  providerCountTokens?: number;
  providerCountExact?: boolean;
  providerCountStatus: "not_needed" | "unavailable" | "succeeded" | "failed";
  measuredInputTokens: number;
  countSource: "local_estimate" | "provider_count";
  admissionLimitTokens: number;
  pressure: number;
  pressureLevel: ContextPressureLevel;
  softLimitExceeded: boolean;
  hardLimitExceeded: boolean;
  admissionLimitExceeded: boolean;
  overBudget: boolean;
}

const LOCAL_ADMISSION_RATIO = 0.95;

export function calculateContextBudget(limits: ResolvedModelContextLimits): ContextBudget {
  const inputCapacityTokens = Math.min(
    limits.maxInputTokens ?? limits.contextWindowTokens,
    limits.contextWindowTokens - limits.outputReserveTokens,
  );
  if (limits.hardInputTokens > inputCapacityTokens) {
    throw new Error("Hard input limit exceeds the model input capacity.");
  }
  if (limits.softInputTokens >= limits.hardInputTokens) {
    throw new Error("Soft input limit must be smaller than the hard input limit.");
  }
  if (limits.recoveryTargetTokens >= limits.softInputTokens) {
    throw new Error("Recovery target must be smaller than the soft input limit.");
  }
  if (limits.preparationInputTokens <= 0) {
    throw new Error("Preparation trigger must be positive.");
  }
  if (limits.preparationInputTokens >= limits.recoveryTargetTokens) {
    throw new Error("Preparation trigger must be smaller than the recovery target.");
  }

  return {
    contextWindowTokens: limits.contextWindowTokens,
    ...(limits.maxInputTokens !== undefined ? { maxInputTokens: limits.maxInputTokens } : {}),
    outputReserveTokens: limits.outputReserveTokens,
    inputCapacityTokens,
    preparationInputTokens: limits.preparationInputTokens,
    recoveryTargetTokens: limits.recoveryTargetTokens,
    softInputTokens: limits.softInputTokens,
    hardInputTokens: limits.hardInputTokens,
    localAdmissionInputTokens: Math.floor(limits.hardInputTokens * LOCAL_ADMISSION_RATIO),
  };
}

export function contextPressureLevel(input: {
  measuredInputTokens: number;
  softInputTokens: number;
  admissionLimitTokens: number;
  hardInputTokens: number;
}): ContextPressureLevel {
  if (input.measuredInputTokens > input.hardInputTokens) return "overflow";
  if (input.measuredInputTokens > input.admissionLimitTokens) return "high";
  if (input.measuredInputTokens >= input.softInputTokens) return "elevated";
  return "normal";
}

export function roundContextPressure(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
