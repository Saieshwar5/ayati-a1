import { describe, expect, it } from "vitest";
import {
  appendActiveFailure,
  getActiveFailures,
  resolveActiveFailures,
  resolveReportedDenialFailures,
} from "../../src/ivec/agent-runner/failure-lifecycle.js";
import { hasRepeatedRepairFailure } from "../../src/ivec/agent-runner/repair-feedback.js";
import type { FailureRecord, LoopState } from "../../src/ivec/types.js";

describe("failure repair lifecycle", () => {
  it("keeps resolved repairs in history while removing them from active feedback", () => {
    const current = state();
    appendActiveFailure(current, navigationFailure(1));
    appendActiveFailure(current, navigationFailure(2));
    appendActiveFailure(current, navigationFailure(3));

    expect(hasRepeatedRepairFailure(current.failureHistory)).toBe(true);

    const receipt = resolveActiveFailures(current, {
      scopes: ["navigation"],
      iteration: 4,
      kind: "accepted_mode_transition",
    });

    expect(receipt).toMatchObject({
      iteration: 4,
      kind: "accepted_mode_transition",
      scopes: ["navigation"],
      resolved: [{ step: 1 }, { step: 2 }, { step: 3 }],
    });
    expect(current.failureHistory).toHaveLength(3);
    expect(current.failureHistory.every((failure) => (
      failure.resolution?.iteration === 4
      && failure.resolution.kind === "accepted_mode_transition"
    ))).toBe(true);
    expect(getActiveFailures(current.failureHistory)).toEqual([]);
    expect(hasRepeatedRepairFailure(current.failureHistory)).toBe(false);

    appendActiveFailure(current, navigationFailure(5));

    expect(current.failureHistory).toHaveLength(4);
    expect(getActiveFailures(current.failureHistory)).toEqual([
      expect.objectContaining({ step: 5 }),
    ]);
    expect(current.failureHistory[3]?.resolution).toBeUndefined();
    expect(hasRepeatedRepairFailure(current.failureHistory)).toBe(false);
  });

  it("resolves only the repair scopes proven by the recovery event", () => {
    const current = state();
    appendActiveFailure(current, navigationFailure(1));
    appendActiveFailure(current, {
      ...navigationFailure(2),
      reason: "Read failed.",
      repairScope: "action",
    });

    resolveActiveFailures(current, {
      scopes: ["navigation"],
      iteration: 3,
      kind: "accepted_mode_transition",
    });

    expect(getActiveFailures(current.failureHistory)).toEqual([
      expect.objectContaining({ step: 2, repairScope: "action" }),
    ]);
    expect(current.failureHistory[0]?.resolution).toEqual({
      iteration: 3,
      kind: "accepted_mode_transition",
    });
    expect(current.failureHistory[1]?.resolution).toBeUndefined();
  });

  it("lets accepted validation clear validation repairs without clearing action failures", () => {
    const current = state();
    appendActiveFailure(current, {
      ...navigationFailure(1),
      reason: "The blocked terminal outcome was unsupported.",
      repairScope: "validation",
    });
    appendActiveFailure(current, {
      ...navigationFailure(2),
      reason: "The filesystem action failed.",
      repairScope: "action",
    });

    resolveActiveFailures(current, {
      scopes: ["navigation", "validation"],
      iteration: 3,
      kind: "validation_accepted",
    });

    expect(current.failureHistory[0]?.resolution).toEqual({
      iteration: 3,
      kind: "validation_accepted",
    });
    expect(getActiveFailures(current.failureHistory)).toEqual([
      expect.objectContaining({
        step: 2,
        repairScope: "action",
        reason: "The filesystem action failed.",
      }),
    ]);
  });

  it("accounts for only the exact permission-denied call selected by validation", () => {
    const current = state();
    appendActiveFailure(current, {
      step: 1,
      failureType: "permission",
      reason: "External write was denied.",
      blockedTargets: ["/external/report.txt"],
      failedCallIds: ["call-denied"],
      repairScope: "action",
    });
    appendActiveFailure(current, {
      step: 2,
      failureType: "permission",
      reason: "A different write was denied.",
      blockedTargets: ["/external/other.txt"],
      failedCallIds: ["call-other"],
      repairScope: "action",
    });
    appendActiveFailure(current, {
      step: 3,
      failureType: "tool_error",
      reason: "An unrelated tool failed.",
      blockedTargets: ["db_query"],
      failedCallIds: ["call-tool-error"],
      repairScope: "action",
    });

    const receipt = resolveReportedDenialFailures(current, {
      callIds: ["call-denied"],
      iteration: 4,
    });

    expect(receipt).toMatchObject({
      kind: "denial_reported",
      scopes: ["action"],
      resolved: [{
        step: 1,
        failedCallIds: ["call-denied"],
      }],
    });
    expect(current.failureHistory[0]?.resolution).toEqual({
      iteration: 4,
      kind: "denial_reported",
    });
    expect(getActiveFailures(current.failureHistory)).toEqual([
      expect.objectContaining({ step: 2, failedCallIds: ["call-other"] }),
      expect.objectContaining({ step: 3, failureType: "tool_error" }),
    ]);
  });

  it("does not partially account for a failed step containing multiple denied calls", () => {
    const current = state();
    appendActiveFailure(current, {
      step: 1,
      failureType: "permission",
      reason: "Two external writes were denied.",
      blockedTargets: ["/external/one.txt", "/external/two.txt"],
      failedCallIds: ["call-one", "call-two"],
      repairScope: "action",
    });

    expect(resolveReportedDenialFailures(current, {
      callIds: ["call-one"],
      iteration: 2,
    })).toBeUndefined();
    expect(getActiveFailures(current.failureHistory)).toHaveLength(1);

    expect(resolveReportedDenialFailures(current, {
      callIds: ["call-one", "call-two"],
      iteration: 3,
    })).toMatchObject({
      kind: "denial_reported",
      resolved: [{ step: 1 }],
    });
  });

  it("detects repeated semantic gate failures even when attempted targets vary", () => {
    const current = state();
    for (const [index, target] of [
      "/tmp/site/index.html",
      "/tmp/site/styles.css",
      "/tmp/site/script.js",
    ].entries()) {
      appendActiveFailure(current, {
        step: index + 1,
        failureType: "validation_error",
        reason: `MODE_TARGET_UNVERIFIED: Target is not grounded: ${target}.`,
        blockedTargets: [target],
        repairCode: "R_MODE_TRANSITION_INVALID",
        repairScope: "navigation",
      });
    }

    expect(hasRepeatedRepairFailure(current.failureHistory)).toBe(true);
  });
});

function navigationFailure(step: number): FailureRecord {
  return {
    step,
    failureType: "validation_error",
    reason: "Choose a supported capability.",
    blockedTargets: ["domain:filesystem"],
    repairCode: "R_MODE_TRANSITION_INVALID",
    repairScope: "navigation",
  };
}

function state(): LoopState {
  return {
    runId: "RUN-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage: "Find the requested file.",
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    harnessContext: {},
  };
}
