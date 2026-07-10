import { describe, expect, it } from "vitest";
import {
  calculateContextBudget,
  contextPressureLevel,
} from "../../src/prompt/context-budget.js";
import type { ResolvedModelContextLimits } from "../../src/providers/shared/model-context-limits.js";

describe("context budget", () => {
  it("uses the 70K soft, 60K recovery, and 100K hard contract for a 128K model", () => {
    const budget = calculateContextBudget(limits({
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
    }));

    expect(budget).toEqual({
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
      inputCapacityTokens: 119_808,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
      localAdmissionInputTokens: 95_000,
    });
  });

  it("reports the provider input capacity separately from policy limits", () => {
    const budget = calculateContextBudget(limits({
      contextWindowTokens: 1_000_000,
      maxInputTokens: 900_000,
      outputReserveTokens: 16_000,
      recoveryTargetTokens: 460_000,
      softInputTokens: 550_000,
      hardInputTokens: 780_000,
    }));

    expect(budget.inputCapacityTokens).toBe(900_000);
    expect(budget.hardInputTokens).toBe(780_000);
    expect(budget.localAdmissionInputTokens).toBe(741_000);
  });

  it("classifies pressure levels at deterministic boundaries", () => {
    const classify = (measuredInputTokens: number) => contextPressureLevel({
      measuredInputTokens,
      softInputTokens: 70_000,
      admissionLimitTokens: 95_000,
      hardInputTokens: 100_000,
    });
    expect(classify(69_999)).toBe("normal");
    expect(classify(70_000)).toBe("elevated");
    expect(classify(95_001)).toBe("high");
    expect(classify(100_001)).toBe("overflow");
  });
});

function limits(overrides: Partial<ResolvedModelContextLimits>): ResolvedModelContextLimits {
  return {
    provider: "test",
    model: "test-128k",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    source: "configured",
    ...overrides,
  };
}
