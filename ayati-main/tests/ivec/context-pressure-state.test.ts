import { describe, expect, it } from "vitest";
import type { ContextCompilationReceipt } from "../../src/prompt/context-compilation-receipt.js";
import {
  createInitialContextPressureState,
  updateContextPressureState,
} from "../../src/ivec/context-pressure-state.js";

describe("context pressure state", () => {
  it("counts at most one soft breach per runner iteration", () => {
    const first = updateContextPressureState({
      current: createInitialContextPressureState(),
      receipt: receipt({ softLimitExceeded: true }),
      iteration: 4,
    });
    const repair = updateContextPressureState({
      current: first,
      receipt: receipt({ softLimitExceeded: true, decisionAttempt: 2 }),
      iteration: 4,
    });
    const later = updateContextPressureState({
      current: repair,
      receipt: receipt({ softLimitExceeded: true, candidateInputTokens: 74_000 }),
      iteration: 5,
    });

    expect(first.softLimitBreachCount).toBe(1);
    expect(repair.softLimitBreachCount).toBe(1);
    expect(later.softLimitBreachCount).toBe(2);
    expect(later.peakCandidateInputTokens).toBe(74_000);
  });

  it("records rejected admissions without changing pressure mode", () => {
    const state = updateContextPressureState({
      receipt: receipt({ admitted: false, hardLimitExceeded: true }),
      iteration: 1,
    });

    expect(state.mode).toBe("full");
    expect(state.admissionRejectionCount).toBe(1);
    expect(state.latestReceipt?.admitted).toBe(false);
  });

  it("advances to tool compaction and does not regress on a later full receipt", () => {
    const compacted = updateContextPressureState({
      receipt: receipt({ mode: "tool_compact" }),
      iteration: 2,
    });
    const laterFull = updateContextPressureState({
      current: compacted,
      receipt: receipt({ mode: "full", softLimitExceeded: false }),
      iteration: 3,
    });

    expect(compacted.mode).toBe("tool_compact");
    expect(laterFull.mode).toBe("tool_compact");
  });
});

function receipt(overrides: Partial<ContextCompilationReceipt> = {}): ContextCompilationReceipt {
  return {
    schemaVersion: 1,
    decisionAttempt: 1,
    mode: "full",
    provider: "test",
    model: "test-128k",
    candidateInputTokens: 72_000,
    finalInputTokens: 72_000,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    admissionLimitTokens: 95_000,
    softLimitExceeded: true,
    hardLimitExceeded: false,
    admitted: true,
    countSource: "local_estimate",
    transformations: [],
    ...overrides,
  };
}
