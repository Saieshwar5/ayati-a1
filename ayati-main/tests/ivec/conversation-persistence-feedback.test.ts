import { describe, expect, it } from "vitest";
import { readFeedbackConversationPersistenceState } from "../../src/ivec/conversation-persistence-feedback.js";

describe("conversation persistence feedback", () => {
  it("accepts a truthful direct-conversation state", () => {
    expect(readFeedbackConversationPersistenceState({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
    })).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
    });
  });

  it("rejects unknown persistence states", () => {
    expect(readFeedbackConversationPersistenceState({
      database: "saved",
      materialization: "written",
      git: "not_committed",
    })).toBeUndefined();
  });

  it("rejects a committed state without its commit identity", () => {
    expect(readFeedbackConversationPersistenceState({
      database: "saved",
      materialization: "materialized",
      git: "committed",
      materializedPath: "conversations/000001-session.md",
    })).toBeUndefined();
  });

  it("rejects materialized paths attached to incomplete states", () => {
    expect(readFeedbackConversationPersistenceState({
      database: "saved",
      materialization: "pending",
      git: "not_committed",
      materializedPath: "conversations/000001-session.md",
    })).toBeUndefined();
  });
});
