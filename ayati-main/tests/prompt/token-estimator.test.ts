import { describe, it, expect } from "vitest";
import {
  estimateTextTokens,
  estimateTurnInputTokens,
} from "../../src/prompt/token-estimator.js";

describe("token-estimator", () => {
  it("estimates text tokens from utf-8 bytes", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
  });

  it("estimates turn input tokens including tool schema", () => {
    const estimate = estimateTurnInputTokens({
      messages: [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Hello there" },
      ],
      tools: [
        {
          name: "shell",
          description: "run shell commands",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });

    expect(estimate.messageTokens).toBeGreaterThan(0);
    expect(estimate.toolSchemaTokens).toBeGreaterThan(0);
    expect(estimate.totalTokens).toBeGreaterThan(estimate.messageTokens);
  });
});
