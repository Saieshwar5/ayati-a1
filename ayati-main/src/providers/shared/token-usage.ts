import type { LlmTokenUsage } from "../../core/contracts/llm-protocol.js";

export function readOpenAiCompatibleUsage(
  provider: string,
  model: string,
  response: unknown,
): LlmTokenUsage | undefined {
  const usage = readRecord(response)?.["usage"];
  if (!isRecord(usage)) return undefined;
  const inputTokens = nonNegativeInteger(usage["prompt_tokens"]);
  const outputTokens = nonNegativeInteger(usage["completion_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const totalTokens = nonNegativeInteger(usage["total_tokens"]) ?? inputTokens + outputTokens;
  const details = isRecord(usage["prompt_tokens_details"])
    ? usage["prompt_tokens_details"]
    : undefined;
  const cachedInputTokens = details
    ? nonNegativeInteger(details["cached_tokens"] ?? details["cached_prompt_tokens"])
    : undefined;
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    exact: true,
  };
}

export function readAnthropicUsage(model: string, response: unknown): LlmTokenUsage | undefined {
  const usage = readRecord(response)?.["usage"];
  if (!isRecord(usage)) return undefined;
  const uncachedInputTokens = nonNegativeInteger(usage["input_tokens"]);
  const outputTokens = nonNegativeInteger(usage["output_tokens"]);
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = nonNegativeInteger(usage["cache_read_input_tokens"]) ?? 0;
  const cacheCreationInputTokens = nonNegativeInteger(usage["cache_creation_input_tokens"]) ?? 0;
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens;
  return {
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    exact: true,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}
