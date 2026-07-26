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
        event: "transition_requested",
        data: { source: "execute" },
      },
      {
        stage: "virtual_mode",
        event: "transition_applied",
        data: {
          mode: {
            active: "validation",
            revision: 3,
            validation: { status: "passed", checks: [{ status: "passed" }] },
          },
        },
      },
    ];

    const summary = events.reduce(
      (current, event) => updateNavigationFeedbackSummary(current, event),
      undefined as ReturnType<typeof updateNavigationFeedbackSummary>,
    );

    expect(summary).toEqual({
      currentMode: "validation",
      modeRevision: 3,
      transitionRequests: 3,
      transitionAccepted: 3,
      transitionRejected: 0,
      bindingAttempts: 1,
      bindingStatus: "resolved",
      validationAttempts: 1,
      validationAccepted: 1,
      validationRejected: 0,
    });
  });

  it("counts an applied failed validation checklist without rejecting the transition", () => {
    const summary = updateNavigationFeedbackSummary(undefined, {
      stage: "virtual_mode",
      event: "transition_applied",
      data: {
        mode: {
          active: "validation",
          revision: 1,
          validation: { status: "failed", checks: [{ status: "failed" }] },
        },
      },
    });

    expect(summary).toMatchObject({
      currentMode: "validation",
      transitionAccepted: 1,
      transitionRejected: 0,
      validationAttempts: 1,
      validationAccepted: 0,
      validationRejected: 1,
    });
  });

  it("recognizes transient context retrieval but never invents resolve as a current mode", () => {
    const retrieved = updateNavigationFeedbackSummary(undefined, {
      stage: "virtual_mode",
      event: "transition_applied",
      data: { mode: { active: "context.retrieve", revision: 1 } },
    });

    expect(retrieved?.currentMode).toBe("context.retrieve");
    expect(readNavigationFeedbackSummary({
      ...retrieved,
      currentMode: "resolve",
    })).toBeUndefined();
  });

  it("keeps the latest mode while merging final counters with observed events", () => {
    const final = createAgentFeedbackNavigationSummary();
    final.transitionRequests = 2;
    final.bindingAttempts = 1;
    final.bindingStatus = "resolved";
    const observed = readNavigationFeedbackSummary({
      currentMode: "validation",
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
      currentMode: "validation",
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
