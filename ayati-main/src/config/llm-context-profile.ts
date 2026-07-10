export interface LlmModelContextLimitConfig {
  contextWindowTokens: number;
  maxInputTokens?: number;
  outputReserveTokens?: number;
  softInputTokens?: number;
  recoveryTargetTokens?: number;
  hardInputTokens?: number;
}

export interface LlmContextPressureThresholds {
  inputCapacityTokens: number;
  recoveryTargetTokens: number;
  softInputTokens: number;
  hardInputTokens: number;
}

export const MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_LLM_OUTPUT_RESERVE_TOKENS = 8_192;

const DEFAULT_SOFT_INPUT_RATIO = 70_000 / 128_000;
const DEFAULT_RECOVERY_TARGET_RATIO = 60_000 / 128_000;
const DEFAULT_HARD_INPUT_RATIO = 100_000 / 128_000;

export function resolveLlmContextPressureThresholds(
  limits: LlmModelContextLimitConfig,
): LlmContextPressureThresholds {
  const outputReserveTokens = limits.outputReserveTokens ?? DEFAULT_LLM_OUTPUT_RESERVE_TOKENS;
  const inputCapacityTokens = Math.min(
    limits.maxInputTokens ?? limits.contextWindowTokens,
    limits.contextWindowTokens - outputReserveTokens,
  );
  const hardInputTokens = limits.hardInputTokens
    ?? Math.min(inputCapacityTokens, Math.floor(limits.contextWindowTokens * DEFAULT_HARD_INPUT_RATIO));
  const softInputTokens = limits.softInputTokens
    ?? Math.min(hardInputTokens - 1, Math.floor(limits.contextWindowTokens * DEFAULT_SOFT_INPUT_RATIO));
  const recoveryTargetTokens = limits.recoveryTargetTokens
    ?? Math.min(softInputTokens - 1, Math.floor(limits.contextWindowTokens * DEFAULT_RECOVERY_TARGET_RATIO));

  if (recoveryTargetTokens < 1 || softInputTokens < 2 || hardInputTokens < 3) {
    throw new Error("context pressure thresholds must leave positive recovery, soft, and hard budgets");
  }
  if (hardInputTokens > inputCapacityTokens) {
    throw new Error("hardInputTokens must not exceed the model input capacity");
  }
  if (softInputTokens >= hardInputTokens) {
    throw new Error("softInputTokens must be smaller than hardInputTokens");
  }
  if (recoveryTargetTokens >= softInputTokens) {
    throw new Error("recoveryTargetTokens must be smaller than softInputTokens");
  }

  return {
    inputCapacityTokens,
    recoveryTargetTokens,
    softInputTokens,
    hardInputTokens,
  };
}
