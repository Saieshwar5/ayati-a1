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
const PROVIDER_COUNT_PRESSURE_THRESHOLD = 0.7;

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
  const correctedLocalEstimateTokens = Math.ceil(localEstimateTokens * LOCAL_ESTIMATE_CORRECTION);
  const localPressure = correctedLocalEstimateTokens / budget.usableInputTokens;
  const providerCountResult: ProviderCountResult = localPressure >= PROVIDER_COUNT_PRESSURE_THRESHOLD
    ? await tryProviderCount(input.provider, input.turnInput)
    : { status: "not_needed" as const };
  const providerCount = providerCountResult.count;
  const measuredInputTokens = providerCount
    ? providerCount.exact
      ? providerCount.inputTokens
      : Math.max(correctedLocalEstimateTokens, providerCount.inputTokens)
    : correctedLocalEstimateTokens;
  const pressure = measuredInputTokens / budget.usableInputTokens;

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
    pressure: roundContextPressure(pressure),
    pressureLevel: contextPressureLevel(pressure),
    overBudget: measuredInputTokens > budget.usableInputTokens,
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
