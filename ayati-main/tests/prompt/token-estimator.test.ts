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
          name: "process_run",
          description: "run one project executable",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });

    expect(estimate.messageTokens).toBeGreaterThan(0);
    expect(estimate.toolSchemaTokens).toBeGreaterThan(0);
    expect(estimate.totalTokens).toBeGreaterThan(estimate.messageTokens);
  });

  it("includes multimodal image overhead in message tokens", () => {
    const textOnly = estimateTurnInputTokens({
      messages: [{ role: "user", content: [{ type: "text", text: "inspect this" }] }],
    });
    const withImage = estimateTurnInputTokens({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", imagePath: "/tmp/example.png", mimeType: "image/png" },
        ],
      }],
    });

    expect(withImage.messageTokens).toBeGreaterThanOrEqual(textOnly.messageTokens + 850);
  });
});
