import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";

interface FireworksTokenPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
}

const FIREWORKS_SERVERLESS_PRICING_SOURCE = "https://docs.fireworks.ai/serverless/pricing";

const MODEL_PRICING: Array<{
  pattern: RegExp;
  pricing: FireworksTokenPricing;
}> = [
  {
    pattern: /(?:^|[/_-])minimax[-_/]?m?2p?5(?:$|[^a-z0-9])/i,
    pricing: {
      inputUsdPerMillion: 0.30,
      cachedInputUsdPerMillion: 0.03,
      outputUsdPerMillion: 1.20,
      source: FIREWORKS_SERVERLESS_PRICING_SOURCE,
    },
  },
  {
    pattern: /(?:^|[/_-])minimax[-_/]?m?2p?7(?:$|[^a-z0-9])/i,
    pricing: {
      inputUsdPerMillion: 0.30,
      cachedInputUsdPerMillion: 0.06,
      outputUsdPerMillion: 1.20,
      source: FIREWORKS_SERVERLESS_PRICING_SOURCE,
    },
  },
  {
    pattern: /(?:^|[/_-])minimax[-_/]?m?3(?:$|[^a-z0-9])/i,
    pricing: {
      inputUsdPerMillion: 0.30,
      cachedInputUsdPerMillion: 0.06,
      outputUsdPerMillion: 1.20,
      source: FIREWORKS_SERVERLESS_PRICING_SOURCE,
    },
  },
];

export function estimateFireworksCost(model: string, usage: LlmTokenUsage): LlmCostEstimate | undefined {
  const pricing = findPricing(model);
  if (!pricing) {
    return undefined;
  }

  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const inputCostUsd = priceTokens(uncachedInputTokens, pricing.inputUsdPerMillion);
  const cachedInputCostUsd = priceTokens(cachedInputTokens, pricing.cachedInputUsdPerMillion);
  const outputCostUsd = priceTokens(usage.outputTokens, pricing.outputUsdPerMillion);

  return {
    currency: "USD",
    inputCostUsd,
    cachedInputCostUsd,
    outputCostUsd,
    totalCostUsd: roundUsd(inputCostUsd + cachedInputCostUsd + outputCostUsd),
    pricingSource: pricing.source,
  };
}

function findPricing(model: string): FireworksTokenPricing | undefined {
  return MODEL_PRICING.find((entry) => entry.pattern.test(model))?.pricing;
}

function priceTokens(tokens: number, usdPerMillion: number): number {
  return roundUsd((Math.max(0, tokens) / 1_000_000) * usdPerMillion);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
