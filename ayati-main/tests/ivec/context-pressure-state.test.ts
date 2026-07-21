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

  it("ignores repair-only pressure when advancing recovery policy", () => {
    const state = updateContextPressureState({
      receipt: receipt({
        decisionAttempt: 2,
        mode: "tool_compact",
        finalInputTokens: 72_000,
        targetReached: false,
        needsEscalation: true,
      }),
      iteration: 4,
    });

    expect(state.softLimitBreachCount).toBe(0);
    expect(state.unresolvedPressureStreak).toBe(0);
    expect(state.recommendedMode).toBeUndefined();
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

  it("recommends an agent-stream checkpoint after two unresolved iterations", () => {
    const first = updateContextPressureState({
      receipt: unresolvedReceipt(),
      iteration: 2,
    });
    const second = updateContextPressureState({
      current: first,
      receipt: unresolvedReceipt({ candidateInputTokens: 84_000 }),
      iteration: 3,
    });

    expect(first.unresolvedPressureStreak).toBe(1);
    expect(first.recommendedMode).toBeUndefined();
    expect(second.mode).toBe("tool_compact");
    expect(second.unresolvedPressureStreak).toBe(2);
    expect(second.recommendedMode).toBe("stream_checkpoint");
    expect(second.escalationReason).toBe("repeated_unresolved_pressure");
  });

  it("counts enforced pressure when no tool call can be compacted", () => {
    const first = updateContextPressureState({
      receipt: receipt({
        toolProjectionPolicy: "enforce",
        targetReached: false,
        needsEscalation: true,
      }),
      iteration: 2,
    });
    const second = updateContextPressureState({
      current: first,
      receipt: receipt({
        toolProjectionPolicy: "enforce",
        targetReached: false,
        needsEscalation: true,
      }),
      iteration: 3,
    });

    expect(first.mode).toBe("full");
    expect(first.unresolvedPressureStreak).toBe(1);
    expect(second.recommendedMode).toBe("stream_checkpoint");
  });

  it("does not advance unresolved pressure from a shadow projection", () => {
    const state = updateContextPressureState({
      receipt: receipt({
        toolProjectionPolicy: "shadow",
        targetReached: false,
        needsEscalation: true,
      }),
      iteration: 2,
    });

    expect(state.unresolvedPressureStreak).toBe(0);
    expect(state.recommendedMode).toBeUndefined();
  });

  it("recommends an agent-stream checkpoint immediately near the admission limit", () => {
    const state = updateContextPressureState({
      receipt: unresolvedReceipt({
        finalInputTokens: 86_000,
        admissionLimitTokens: 95_000,
      }),
      iteration: 2,
    });

    expect(state.unresolvedPressureStreak).toBe(1);
    expect(state.recommendedMode).toBe("stream_checkpoint");
    expect(state.escalationReason).toBe("near_admission_limit");
  });

  it("resets unresolved pressure after successful recovery without regressing mode", () => {
    const unresolved = updateContextPressureState({
      receipt: unresolvedReceipt(),
      iteration: 2,
    });
    const recovered = updateContextPressureState({
      current: unresolved,
      receipt: receipt({
        mode: "tool_compact",
        finalInputTokens: 59_000,
        targetReached: true,
        needsEscalation: false,
      }),
      iteration: 3,
    });
    const laterUnresolved = updateContextPressureState({
      current: recovered,
      receipt: unresolvedReceipt(),
      iteration: 4,
    });

    expect(recovered.mode).toBe("tool_compact");
    expect(recovered.unresolvedPressureStreak).toBe(0);
    expect(recovered.successfulRecoveryCount).toBe(1);
    expect(laterUnresolved.unresolvedPressureStreak).toBe(1);
    expect(laterUnresolved.recommendedMode).toBeUndefined();
  });

  it("resets an unresolved streak when a later primary request is below soft pressure", () => {
    const unresolved = updateContextPressureState({
      receipt: unresolvedReceipt(),
      iteration: 2,
    });
    const belowSoft = updateContextPressureState({
      current: unresolved,
      receipt: receipt({
        candidateInputTokens: 55_000,
        finalInputTokens: 55_000,
        softLimitExceeded: false,
      }),
      iteration: 3,
    });

    expect(belowSoft.mode).toBe("tool_compact");
    expect(belowSoft.unresolvedPressureStreak).toBe(0);
    expect(belowSoft.successfulRecoveryCount).toBe(0);
  });

  it("keeps an existing recommendation after a later recovery", () => {
    const recommended = updateContextPressureState({
      receipt: unresolvedReceipt({ finalInputTokens: 90_000 }),
      iteration: 2,
    });
    const recovered = updateContextPressureState({
      current: recommended,
      receipt: receipt({
        mode: "tool_compact",
        finalInputTokens: 58_000,
        targetReached: true,
        needsEscalation: false,
      }),
      iteration: 3,
    });

    expect(recovered.recommendedMode).toBe("stream_checkpoint");
    expect(recovered.escalationReason).toBe("near_admission_limit");
    expect(recovered.unresolvedPressureStreak).toBe(0);
  });
});

function unresolvedReceipt(
  overrides: Partial<ContextCompilationReceipt> = {},
): ContextCompilationReceipt {
  return receipt({
    mode: "tool_compact",
    finalInputTokens: 72_000,
    targetReached: false,
    needsEscalation: true,
    ...overrides,
  });
}

function receipt(overrides: Partial<ContextCompilationReceipt> = {}): ContextCompilationReceipt {
  return {
    schemaVersion: 2,
    decisionAttempt: 1,
    mode: "full",
    provider: "test",
    model: "test-128k",
    candidateInputTokens: 72_000,
    finalInputTokens: 72_000,
    preparationInputTokens: 55_000,
    recoveryTargetTokens: 60_000,
    softInputTokens: 70_000,
    hardInputTokens: 100_000,
    admissionLimitTokens: 95_000,
    forcedBarrierTokens: 85_000,
    nextDecisionReserveTokens: 10_000,
    softLimitExceeded: true,
    hardLimitExceeded: false,
    admitted: true,
    countSource: "local_estimate",
    transformations: [],
    ...overrides,
  };
}
