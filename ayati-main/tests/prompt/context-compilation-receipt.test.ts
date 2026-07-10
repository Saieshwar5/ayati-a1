import { describe, expect, it } from "vitest";
import {
  assertContextIsAdmissible,
  buildFullContextCompilationReceipt,
  ContextInputLimitError,
} from "../../src/prompt/context-compilation-receipt.js";
import type { ContextBudgetReport } from "../../src/prompt/context-budget.js";

describe("context compilation receipt", () => {
  it("records an unchanged full-context compilation", () => {
    const receipt = buildFullContextCompilationReceipt(report(), 2);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      decisionAttempt: 2,
      mode: "full",
      candidateInputTokens: 72_000,
      finalInputTokens: 72_000,
      softLimitExceeded: true,
      admitted: true,
      transformations: [],
    });
  });

  it("rejects a request above its conservative admission limit", () => {
    const receipt = buildFullContextCompilationReceipt(report({
      measuredInputTokens: 96_000,
      admissionLimitTokens: 95_000,
      admissionLimitExceeded: true,
    }), 1);

    expect(() => assertContextIsAdmissible(receipt)).toThrow(ContextInputLimitError);
  });
});

function report(overrides: Partial<ContextBudgetReport> = {}): ContextBudgetReport {
  return {
    provider: "test",
    model: "test-128k",
    limitSource: "default_128k",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    inputCapacityTokens: 119_808,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    localAdmissionInputTokens: 95_000,
    localEstimateTokens: 65_000,
    correctedLocalEstimateTokens: 72_000,
    providerCountStatus: "unavailable",
    measuredInputTokens: 72_000,
    countSource: "local_estimate",
    admissionLimitTokens: 95_000,
    pressure: 0.72,
    pressureLevel: "elevated",
    softLimitExceeded: true,
    hardLimitExceeded: false,
    admissionLimitExceeded: false,
    overBudget: false,
    ...overrides,
  };
}
