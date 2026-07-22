import { describe, expect, it } from "vitest";
import {
  createAgentFeedbackNavigationSummary,
  mergeNavigationFeedbackSummary,
  readNavigationFeedbackSummary,
  updateNavigationFeedbackSummary,
} from "../../src/ivec/feedback-navigation.js";

describe("navigation feedback reduction", () => {
  it("reduces the single-loop mutation path without inventing resolver work", () => {
    const events = [
      { stage: "virtual_mode", event: "transition_requested", data: { source: "ENTRY" } },
      {
        stage: "virtual_mode",
        event: "transition_applied",
        data: { mode: { active: "observe.locate", revision: 1 } },
      },
      { stage: "virtual_mode", event: "transition_requested", data: { source: "observe.locate" } },
      { stage: "workstream_binding", event: "deterministic_binding_started" },
      { stage: "workstream_binding", event: "deterministic_binding_resolved" },
      {
        stage: "virtual_mode",
        event: "transition_resolved",
        data: { mode: { active: "execute", revision: 2 } },
      },
      {
        stage: "virtual_mode",
        event: "validation_rejected",
        data: { mode: { active: "execute", revision: 2 } },
      },
      {
        stage: "virtual_mode",
        event: "validation_accepted",
        data: { mode: { active: "execute", revision: 2 } },
      },
    ];

    const summary = events.reduce(
      (current, event) => updateNavigationFeedbackSummary(current, event),
      undefined as ReturnType<typeof updateNavigationFeedbackSummary>,
    );

    expect(summary).toEqual({
      currentMode: "execute",
      modeRevision: 2,
      transitionRequests: 2,
      transitionAccepted: 2,
      transitionRejected: 0,
      bindingAttempts: 1,
      bindingStatus: "resolved",
      validationAttempts: 2,
      validationAccepted: 1,
      validationRejected: 1,
    });
  });

  it("keeps the latest mode while merging final counters with observed events", () => {
    const final = createAgentFeedbackNavigationSummary();
    final.transitionRequests = 2;
    final.bindingAttempts = 1;
    final.bindingStatus = "resolved";
    const observed = readNavigationFeedbackSummary({
      currentMode: "execute",
      modeRevision: 3,
      transitionRequests: 2,
      transitionAccepted: 2,
      transitionRejected: 0,
      bindingAttempts: 1,
      bindingStatus: "resolved",
      validationAttempts: 1,
      validationAccepted: 1,
      validationRejected: 0,
    });

    expect(mergeNavigationFeedbackSummary(final, observed)).toMatchObject({
      currentMode: "execute",
      modeRevision: 3,
      transitionRequests: 2,
      bindingAttempts: 1,
      validationAccepted: 1,
    });
  });

  it("does not let an incomplete started signal erase a terminal binding result", () => {
    const final = createAgentFeedbackNavigationSummary();
    final.bindingAttempts = 1;
    final.bindingStatus = "resolved";
    const observed = createAgentFeedbackNavigationSummary();
    observed.bindingAttempts = 1;
    observed.bindingStatus = "started";

    expect(mergeNavigationFeedbackSummary(final, observed)?.bindingStatus).toBe("resolved");
  });
});
