import { describe, expect, it } from "vitest";
import {
  buildExecutionOutcomeFindings,
  isHealthyConversationOutcome,
  isHealthyVerifiedObservationOutcome,
} from "../../src/ivec/execution-outcome-triage.js";

describe("execution outcome triage", () => {
  it("recognizes a healthy direct conversation", () => {
    const input = {
      execution: {
        verification: "not_applicable" as const,
        finalization: "completed" as const,
        commit: "not_required" as const,
      },
      actionSteps: 0,
      toolCalls: 0,
      modeTransitions: 0,
      workstreamBound: false,
    };

    expect(buildExecutionOutcomeFindings(input)).toEqual([]);
    expect(isHealthyConversationOutcome(input)).toBe(true);
    expect(isHealthyVerifiedObservationOutcome(input)).toBe(false);
  });

  it("distinguishes a healthy verified observation from direct conversation", () => {
    const input = {
      execution: {
        verification: "passed" as const,
        finalization: "completed" as const,
        commit: "not_required" as const,
      },
      actionSteps: 2,
      toolCalls: 2,
      modeTransitions: 3,
      workstreamBound: false,
    };

    expect(buildExecutionOutcomeFindings(input)).toEqual([]);
    expect(isHealthyConversationOutcome(input)).toBe(false);
    expect(isHealthyVerifiedObservationOutcome(input)).toBe(true);
  });

  it("does not call a control-only graph run a direct conversation", () => {
    const input = {
      execution: {
        verification: "not_applicable" as const,
        finalization: "completed" as const,
        commit: "not_required" as const,
      },
      actionSteps: 0,
      toolCalls: 0,
      modeTransitions: 1,
      workstreamBound: false,
    };

    expect(isHealthyConversationOutcome(input)).toBe(false);
    expect(isHealthyVerifiedObservationOutcome(input)).toBe(false);
  });

  it("rejects a non-pending commit while task finalization is pending", () => {
    expect(buildExecutionOutcomeFindings({
      execution: {
        verification: "passed",
        finalization: "pending",
        commit: "not_required",
      },
      actionSteps: 1,
      workstreamBound: true,
    })).toEqual([expect.objectContaining({
      code: "workstream_commit_state_mismatch",
      severity: "error",
    })]);
  });

  it("requires commit identity for a committed outcome", () => {
    expect(buildExecutionOutcomeFindings({
      execution: {
        verification: "passed",
        finalization: "completed",
        commit: "committed",
      },
      actionSteps: 1,
      workstreamBound: true,
    })).toEqual([expect.objectContaining({
      code: "commit_identity_missing",
      severity: "error",
    })]);
  });

  it("reports task finalization after failed verification", () => {
    expect(buildExecutionOutcomeFindings({
      execution: {
        verification: "failed",
        finalization: "completed",
        commit: "not_required",
      },
      actionSteps: 1,
      workstreamBound: true,
    })).toEqual([expect.objectContaining({
      code: "finalized_after_failed_verification",
      severity: "warning",
    })]);
  });
});
