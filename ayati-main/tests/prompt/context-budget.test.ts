import { describe, expect, it } from "vitest";
import {
  calculateContextBudget,
  contextPressureLevel,
} from "../../src/prompt/context-budget.js";
import type { ResolvedModelContextLimits } from "../../src/providers/shared/model-context-limits.js";

describe("context budget", () => {
  it("reserves output and proportional safety margin for a 128K model", () => {
    const budget = calculateContextBudget(limits({
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
    }));

    expect(budget).toEqual({
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
      safetyMarginTokens: 6_400,
      usableInputTokens: 113_408,
    });
  });

  it("caps the safety margin and honors a stricter model input limit", () => {
    const budget = calculateContextBudget(limits({
      contextWindowTokens: 1_000_000,
      maxInputTokens: 900_000,
      outputReserveTokens: 16_000,
    }));

    expect(budget.safetyMarginTokens).toBe(16_384);
    expect(budget.usableInputTokens).toBe(900_000);
  });

  it("classifies pressure levels at deterministic boundaries", () => {
    expect(contextPressureLevel(0.69)).toBe("normal");
    expect(contextPressureLevel(0.7)).toBe("elevated");
    expect(contextPressureLevel(0.85)).toBe("high");
    expect(contextPressureLevel(1)).toBe("overflow");
  });
});

function limits(overrides: Partial<ResolvedModelContextLimits>): ResolvedModelContextLimits {
  return {
    provider: "test",
    model: "test-128k",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    source: "configured",
    ...overrides,
  };
}
