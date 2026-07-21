import { describe, expect, it } from "vitest";
import {
  assertContextIsAdmissible,
  buildFullContextCompilationReceipt,
  buildStreamCheckpointCompilationReceipt,
  buildToolCompactContextCompilationReceipt,
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

  it("admits a projected final request even when its candidate exceeded the hard limit", () => {
    const receipt = buildToolCompactContextCompilationReceipt({
      candidate: report({
        measuredInputTokens: 105_000,
        hardLimitExceeded: true,
        admissionLimitExceeded: true,
      }),
      final: report({
        measuredInputTokens: 58_000,
        correctedLocalEstimateTokens: 58_000,
        softLimitExceeded: false,
        pressureLevel: "normal",
      }),
      decisionAttempt: 1,
      transformations: [{
        kind: "tool_call_projection",
        callId: "call-1",
        from: "full",
        to: "summary",
        tokensBefore: 20_000,
        tokensAfter: 500,
      }],
    });

    expect(receipt).toMatchObject({
      mode: "tool_compact",
      candidateInputTokens: 105_000,
      finalInputTokens: 58_000,
      candidateHardLimitExceeded: true,
      toolProjectionPolicy: "enforce",
      targetReached: true,
      needsEscalation: false,
      admitted: true,
    });
    expect(() => assertContextIsAdmissible(receipt)).not.toThrow();
  });

  it("records intermediate and final measurements for an agent-stream checkpoint", () => {
    const receipt = buildStreamCheckpointCompilationReceipt({
      candidate: report({ measuredInputTokens: 85_000 }),
      intermediate: report({ measuredInputTokens: 75_000 }),
      final: report({
        measuredInputTokens: 55_000,
        softLimitExceeded: false,
        pressureLevel: "normal",
      }),
      decisionAttempt: 2,
      transformations: [{
        kind: "stream_checkpoint",
        coveredFromSeq: 1,
        coveredToSeq: 4,
        sourceHash: "abc",
        tokensBefore: 20_000,
        tokensAfter: 800,
      }],
      checkpoint: {
        coveredFromSeq: 1,
        coveredToSeq: 4,
        sourceEventCount: 4,
        sourceHash: "abc",
        checkpointTokens: 800,
        cacheStatus: "generated",
        generationAttempts: 1,
      },
    });

    expect(receipt).toMatchObject({
      decisionAttempt: 2,
      mode: "stream_checkpoint",
      candidateInputTokens: 85_000,
      intermediateInputTokens: 75_000,
      finalInputTokens: 55_000,
      targetReached: true,
      admitted: true,
      streamCheckpoint: {
        sourceHash: "abc",
        checkpointTokens: 800,
      },
    });
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
    localMessageTokens: 64_000,
    localToolSchemaTokens: 997,
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
