import { describe, expect, it } from "vitest";
import {
  readAnthropicUsage,
  readOpenAiCompatibleUsage,
} from "../../src/providers/shared/token-usage.js";

describe("provider token usage normalization", () => {
  it("preserves OpenAI-compatible cached and total token usage", () => {
    expect(readOpenAiCompatibleUsage("openrouter", "model-a", {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    })).toEqual({
      provider: "openrouter",
      model: "model-a",
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 80,
      exact: true,
    });
  });

  it("includes Anthropic cache creation and cache reads in total input", () => {
    expect(readAnthropicUsage("claude-test", {
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
        output_tokens: 10,
      },
    })).toEqual({
      provider: "anthropic",
      model: "claude-test",
      inputTokens: 170,
      outputTokens: 10,
      totalTokens: 180,
      cachedInputTokens: 100,
      exact: true,
    });
  });

  it("does not invent usage when required fields are absent", () => {
    expect(readOpenAiCompatibleUsage("openai", "model", { usage: { prompt_tokens: 1 } })).toBeUndefined();
    expect(readAnthropicUsage("model", { usage: { input_tokens: 1 } })).toBeUndefined();
  });
});
