import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput } from "../../src/core/contracts/llm-protocol.js";
import { measureTurnContext } from "../../src/prompt/context-token-counter.js";
import type { ResolvedModelContextLimits } from "../../src/providers/shared/model-context-limits.js";

describe("context token counter", () => {
  it("uses the corrected local estimate for normal-pressure requests", async () => {
    const countInputTokens = vi.fn();
    const report = await measureTurnContext({
      provider: provider(countInputTokens),
      turnInput: turnInput("short request"),
      limits: limits(),
    });

    expect(report.countSource).toBe("local_estimate");
    expect(report.providerCountStatus).toBe("not_needed");
    expect(report.measuredInputTokens).toBe(report.correctedLocalEstimateTokens);
    expect(report.pressureLevel).toBe("normal");
    expect(countInputTokens).not.toHaveBeenCalled();
  });

  it("uses exact provider counting near the pressure boundary", async () => {
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-128k",
      inputTokens: 90_000,
      exact: true,
    });
    const report = await measureTurnContext({
      provider: provider(countInputTokens),
      turnInput: turnInput("x".repeat(330_000)),
      limits: limits(),
    });

    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(report.countSource).toBe("provider_count");
    expect(report.providerCountStatus).toBe("succeeded");
    expect(report.providerCountExact).toBe(true);
    expect(report.measuredInputTokens).toBe(90_000);
    expect(report.pressureLevel).toBe("elevated");
    expect(report.admissionLimitTokens).toBe(100_000);
    expect(report.admissionLimitExceeded).toBe(false);
  });

  it("keeps the conservative local count when an inexact provider count is smaller", async () => {
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-128k",
      inputTokens: 70_000,
      exact: false,
    });
    const report = await measureTurnContext({
      provider: provider(countInputTokens),
      turnInput: turnInput("x".repeat(330_000)),
      limits: limits(),
    });

    expect(report.providerCountExact).toBe(false);
    expect(report.measuredInputTokens).toBe(report.correctedLocalEstimateTokens);
  });

  it("uses the conservative admission limit for an inexact provider count", async () => {
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-128k",
      inputTokens: 96_000,
      exact: false,
    });
    const report = await measureTurnContext({
      provider: provider(countInputTokens),
      turnInput: turnInput("x".repeat(300_000)),
      limits: limits(),
    });

    expect(report.measuredInputTokens).toBe(96_000);
    expect(report.admissionLimitTokens).toBe(95_000);
    expect(report.hardLimitExceeded).toBe(false);
    expect(report.admissionLimitExceeded).toBe(true);
  });

  it("falls back locally when provider counting fails", async () => {
    const countInputTokens = vi.fn().mockRejectedValue(new Error("count unavailable"));
    const report = await measureTurnContext({
      provider: provider(countInputTokens),
      turnInput: turnInput("x".repeat(500_000)),
      limits: limits(),
    });

    expect(report.countSource).toBe("local_estimate");
    expect(report.providerCountStatus).toBe("failed");
    expect(report.overBudget).toBe(true);
    expect(report.admissionLimitTokens).toBe(95_000);
    expect(report.admissionLimitExceeded).toBe(true);
  });

  it("includes native tool schemas in the measured input", async () => {
    const withoutTools = await measureTurnContext({
      provider: provider(),
      turnInput: turnInput("request"),
      limits: limits(),
    });
    const withTools = await measureTurnContext({
      provider: provider(),
      turnInput: {
        ...turnInput("request"),
        tools: [{
          name: "large_tool",
          description: "x".repeat(2_000),
          inputSchema: {
            type: "object",
            properties: { content: { type: "string", description: "y".repeat(2_000) } },
          },
        }],
      },
      limits: limits(),
    });

    expect(withTools.localEstimateTokens).toBeGreaterThan(withoutTools.localEstimateTokens + 900);
  });
});

function provider(countInputTokens?: LlmProvider["countInputTokens"]): LlmProvider {
  return {
    name: "test",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start() {},
    stop() {},
    ...(countInputTokens ? { countInputTokens } : {}),
    async generateTurn() {
      return { type: "assistant", content: "ok" };
    },
  };
}

function turnInput(content: string): LlmTurnInput {
  return {
    messages: [
      { role: "system", content: "system" },
      { role: "user", content },
    ],
  };
}

function limits(): ResolvedModelContextLimits {
  return {
    provider: "test",
    model: "test-128k",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    source: "configured",
  };
}
