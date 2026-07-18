import { describe, expect, it } from "vitest";
import type { GitContextObservabilityEvent } from "ayati-git-context";
import { recordGitContextObservabilityEvent } from "../../src/app/git-context-observability.js";
import type {
  AgentFeedbackEventInput,
  AgentFeedbackLedger,
} from "../../src/ivec/feedback-ledger.js";

describe("Git Context feedback observability bridge", () => {
  it("correlates conversation persistence through its conversation sequence", () => {
    const recorded: AgentFeedbackEventInput[] = [];
    const ledger = feedbackLedger(recorded);

    recordGitContextObservabilityEvent(ledger, gitContextEvent({
      conversationSequence: 4,
      conversationPersistence: {
        database: "saved",
        materialization: "not_requested",
        git: "not_committed",
        plannedPath: "conversations/000004.pending.md",
      },
    }));

    expect(recorded).toEqual([expect.objectContaining({
      sessionId: "S-1",
      seq: 4,
      stage: "git_context_service",
      event: "conversation_persisted",
      data: expect.objectContaining({
        conversationPersistence: {
          database: "saved",
          materialization: "not_requested",
          git: "not_committed",
          plannedPath: "conversations/000004.pending.md",
        },
      }),
    })]);
  });

  it("does not promote invalid conversation sequence data", () => {
    const recorded: AgentFeedbackEventInput[] = [];

    recordGitContextObservabilityEvent(feedbackLedger(recorded), gitContextEvent({
      conversationSequence: 0,
    }));

    expect(recorded[0]?.seq).toBeUndefined();
  });
});

function feedbackLedger(recorded: AgentFeedbackEventInput[]): AgentFeedbackLedger {
  return {
    enabled: true,
    record: (event) => recorded.push(event),
    flush: async () => await Promise.resolve(),
    close: async () => await Promise.resolve(),
  };
}

function gitContextEvent(data: Record<string, unknown>): GitContextObservabilityEvent {
  return {
    v: 1,
    ts: "2026-07-18T10:00:00.000Z",
    tsMs: 1,
    pid: 123,
    level: "info",
    component: "git-context-engine",
    event: "conversation_persisted",
    sessionId: "S-1",
    conversationId: "S-1-C-000004",
    outcome: "succeeded",
    data,
  };
}
