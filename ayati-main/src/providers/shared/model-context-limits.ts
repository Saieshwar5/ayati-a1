import {
  getConfiguredModelContextLimits,
  getModelForProvider,
  isSupportedLlmProvider,
  MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
} from "../../config/llm-runtime-config.js";
import type { LlmProvider } from "../../core/contracts/provider.js";

export type ModelContextLimitSource = "configured" | "default_128k";

export interface ResolvedModelContextLimits {
  provider: string;
  model: string;
  contextWindowTokens: number;
  maxInputTokens?: number;
  outputReserveTokens: number;
  source: ModelContextLimitSource;
}

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

export function resolveModelContextLimits(provider: LlmProvider): ResolvedModelContextLimits {
  if (!isSupportedLlmProvider(provider.name)) {
    return defaultLimits(provider.name, provider.name);
  }

  const model = getModelForProvider(provider.name);
  const configured = getConfiguredModelContextLimits(provider.name, model);
  if (!configured) {
    return defaultLimits(provider.name, model);
  }

  return {
    provider: provider.name,
    model,
    contextWindowTokens: configured.contextWindowTokens,
    ...(configured.maxInputTokens !== undefined ? { maxInputTokens: configured.maxInputTokens } : {}),
    outputReserveTokens: configured.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
    source: "configured",
  };
}

function defaultLimits(provider: string, model: string): ResolvedModelContextLimits {
  return {
    provider,
    model,
    contextWindowTokens: MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
    outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
    source: "default_128k",
  };
}
