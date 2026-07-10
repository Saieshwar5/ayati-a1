import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmTurnInput } from "../core/contracts/llm-protocol.js";
import type { ResolvedModelContextLimits } from "../providers/shared/model-context-limits.js";
import {
  calculateContextBudget,
  contextPressureLevel,
  type ContextBudgetReport,
  roundContextPressure,
} from "./context-budget.js";
import { estimateTurnInputTokens } from "./token-estimator.js";

const LOCAL_ESTIMATE_CORRECTION = 1.1;

export function correctLocalInputTokenEstimate(tokens: number): number {
  return Math.ceil(tokens * LOCAL_ESTIMATE_CORRECTION);
}

interface ProviderCountResult {
  status: "not_needed" | "unavailable" | "succeeded" | "failed";
  count?: Awaited<ReturnType<NonNullable<LlmProvider["countInputTokens"]>>>;
}

export async function measureTurnContext(input: {
  provider: LlmProvider;
  turnInput: LlmTurnInput;
  limits: ResolvedModelContextLimits;
}): Promise<ContextBudgetReport> {
  const budget = calculateContextBudget(input.limits);
  const localEstimateTokens = estimateTurnInputTokens(input.turnInput).totalTokens;
  const correctedLocalEstimateTokens = correctLocalInputTokenEstimate(localEstimateTokens);
  const providerCountResult: ProviderCountResult = correctedLocalEstimateTokens >= budget.softInputTokens
    ? await tryProviderCount(input.provider, input.turnInput)
    : { status: "not_needed" as const };
  const providerCount = providerCountResult.count;
  const measuredInputTokens = providerCount
    ? providerCount.exact
      ? providerCount.inputTokens
      : Math.max(correctedLocalEstimateTokens, providerCount.inputTokens)
    : correctedLocalEstimateTokens;
  const admissionLimitTokens = providerCount?.exact
    ? budget.hardInputTokens
    : budget.localAdmissionInputTokens;
  const pressure = measuredInputTokens / budget.hardInputTokens;
  const softLimitExceeded = measuredInputTokens >= budget.softInputTokens;
  const hardLimitExceeded = measuredInputTokens > budget.hardInputTokens;
  const admissionLimitExceeded = measuredInputTokens > admissionLimitTokens;

  return {
    provider: input.limits.provider,
    model: providerCount?.model ?? input.limits.model,
    limitSource: input.limits.source,
    ...budget,
    localEstimateTokens,
    correctedLocalEstimateTokens,
    ...(providerCount ? {
      providerCountTokens: providerCount.inputTokens,
      providerCountExact: providerCount.exact,
    } : {}),
    providerCountStatus: providerCountResult.status,
    measuredInputTokens,
    countSource: providerCount ? "provider_count" : "local_estimate",
    admissionLimitTokens,
    pressure: roundContextPressure(pressure),
    pressureLevel: contextPressureLevel({
      measuredInputTokens,
      softInputTokens: budget.softInputTokens,
      admissionLimitTokens,
      hardInputTokens: budget.hardInputTokens,
    }),
    softLimitExceeded,
    hardLimitExceeded,
    admissionLimitExceeded,
    overBudget: hardLimitExceeded,
  };
}

async function tryProviderCount(
  provider: LlmProvider,
  turnInput: LlmTurnInput,
): Promise<ProviderCountResult> {
  if (!provider.countInputTokens) {
    return { status: "unavailable" };
  }
  try {
    return {
      status: "succeeded",
      count: await provider.countInputTokens(turnInput),
    };
  } catch {
    return { status: "failed" };
  }
}
