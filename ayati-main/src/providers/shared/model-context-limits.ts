import {
  getConfiguredModelContextLimits,
  getModelForProvider,
  isSupportedLlmProvider,
} from "../../config/llm-runtime-config.js";
import {
  DEFAULT_LLM_OUTPUT_RESERVE_TOKENS,
  MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
  resolveLlmContextPressureThresholds,
} from "../../config/llm-context-profile.js";
import type { LlmProvider } from "../../core/contracts/provider.js";

export type ModelContextLimitSource = "configured" | "default_128k";

export interface ResolvedModelContextLimits {
  provider: string;
  model: string;
  contextWindowTokens: number;
  maxInputTokens?: number;
  outputReserveTokens: number;
  softInputTokens: number;
  recoveryTargetTokens: number;
  hardInputTokens: number;
  source: ModelContextLimitSource;
}

type UnresolvedModelContextLimits = Omit<
  ResolvedModelContextLimits,
  "softInputTokens" | "recoveryTargetTokens" | "hardInputTokens"
> & Partial<Pick<
  ResolvedModelContextLimits,
  "softInputTokens" | "recoveryTargetTokens" | "hardInputTokens"
>>;

export function resolveModelContextLimits(provider: LlmProvider): ResolvedModelContextLimits {
  if (!isSupportedLlmProvider(provider.name)) {
    return defaultLimits(provider.name, provider.name);
  }

  const model = getModelForProvider(provider.name);
  const configured = getConfiguredModelContextLimits(provider.name, model);
  if (!configured) {
    return defaultLimits(provider.name, model);
  }

  return resolveThresholds({
    provider: provider.name,
    model,
    contextWindowTokens: configured.contextWindowTokens,
    ...(configured.maxInputTokens !== undefined ? { maxInputTokens: configured.maxInputTokens } : {}),
    outputReserveTokens: configured.outputReserveTokens ?? DEFAULT_LLM_OUTPUT_RESERVE_TOKENS,
    ...(configured.softInputTokens !== undefined ? { softInputTokens: configured.softInputTokens } : {}),
    ...(configured.recoveryTargetTokens !== undefined ? { recoveryTargetTokens: configured.recoveryTargetTokens } : {}),
    ...(configured.hardInputTokens !== undefined ? { hardInputTokens: configured.hardInputTokens } : {}),
    source: "configured",
  });
}

function defaultLimits(provider: string, model: string): ResolvedModelContextLimits {
  return resolveThresholds({
    provider,
    model,
    contextWindowTokens: MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
    outputReserveTokens: DEFAULT_LLM_OUTPUT_RESERVE_TOKENS,
    source: "default_128k",
  });
}

function resolveThresholds(input: UnresolvedModelContextLimits): ResolvedModelContextLimits {
  const thresholds = resolveLlmContextPressureThresholds(input);

  return {
    ...input,
    recoveryTargetTokens: thresholds.recoveryTargetTokens,
    softInputTokens: thresholds.softInputTokens,
    hardInputTokens: thresholds.hardInputTokens,
  };
}
