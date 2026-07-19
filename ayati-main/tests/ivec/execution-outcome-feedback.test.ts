import { describe, expect, it } from "vitest";
import {
  deriveFeedbackExecutionOutcome,
  readFeedbackExecutionOutcome,
} from "../../src/ivec/execution-outcome-feedback.js";

describe("feedback execution outcome", () => {
  it("describes a direct conversation without treating absent verification as failure", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 0,
      verificationPassed: false,
      finalizationStatus: "not_required",
      committed: false,
    })).toEqual({
      verification: "not_applicable",
      finalization: "completed",
      commit: "not_required",
    });
  });

  it("describes verified action work without a task commit requirement", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 1,
      verificationPassed: true,
      taskBound: false,
      finalizationStatus: "not_required",
    })).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "not_required",
    });
  });

  it("keeps required task finalization and commitment pending", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 1,
      verificationPassed: true,
      taskBound: true,
      finalizationStatus: "not_started",
      committed: false,
    })).toEqual({
      verification: "passed",
      finalization: "pending",
      commit: "pending",
    });
  });

  it("describes a completed task commit", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 1,
      verificationPassed: true,
      taskBound: true,
      finalizationStatus: "committed",
      committed: true,
      commitIdentity: "abc123",
      commitCreated: true,
    })).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "committed",
    });
  });

  it("describes a completed no-change task without inventing a new commit", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 1,
      verificationPassed: true,
      taskBound: true,
      finalizationStatus: "committed",
      commitStatus: "no_change",
      commitCreated: false,
    })).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "no_change",
    });
  });

  it("fails a claimed task commit that has no commit identity", () => {
    expect(deriveFeedbackExecutionOutcome({
      actionSteps: 1,
      verificationPassed: true,
      taskBound: true,
      finalizationStatus: "committed",
      committed: true,
      commitCreated: true,
    })).toEqual({
      verification: "passed",
      finalization: "completed",
      commit: "failed",
    });
  });

  it("validates serialized execution outcomes", () => {
    expect(readFeedbackExecutionOutcome({
      verification: "not_applicable",
      finalization: "completed",
      commit: "not_required",
    })).toEqual({
      verification: "not_applicable",
      finalization: "completed",
      commit: "not_required",
    });
    expect(readFeedbackExecutionOutcome({
      verification: "unknown",
      finalization: "completed",
      commit: "not_required",
    })).toBeUndefined();
  });
});
