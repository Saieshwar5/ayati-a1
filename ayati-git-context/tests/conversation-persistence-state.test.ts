import { describe, expect, it } from "vitest";
import { deriveConversationPersistenceState } from "../src/conversations/conversation-persistence-state.js";

describe("conversation persistence state", () => {
  it("treats a planned path and content hash as not materialized", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004.pending.md",
      contentHash: "sha256:rendered-content",
    })).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000004.pending.md",
      contentHash: "sha256:rendered-content",
    });
  });

  it("reports a requested materialization as pending without claiming a file exists", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004.pending.md",
      materialization: {
        status: "pending",
        targetPath: "conversations/000004-session.md",
      },
    })).toEqual({
      database: "saved",
      materialization: "pending",
      git: "not_committed",
      plannedPath: "conversations/000004.pending.md",
    });
  });

  it("uses completed operation evidence for the materialized path and hash", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004.pending.md",
      contentHash: "sha256:planned-content",
      materialization: {
        status: "completed",
        targetPath: "conversations/000004-session.md",
        contentHash: "sha256:materialized-content",
      },
    })).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "not_committed",
      plannedPath: "conversations/000004.pending.md",
      materializedPath: "conversations/000004-session.md",
      contentHash: "sha256:materialized-content",
    });
  });

  it("fails closed when a completed operation has no materialized content hash", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004-session.md",
      materialization: {
        status: "completed",
        targetPath: "conversations/000004-session.md",
      },
    })).toEqual({
      database: "saved",
      materialization: "failed",
      git: "not_committed",
      plannedPath: "conversations/000004-session.md",
    });
  });

  it("preserves a failed materialization without treating it as a Git failure", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004-session.md",
      materialization: {
        status: "failed",
        targetPath: "conversations/000004-session.md",
      },
    })).toEqual({
      database: "saved",
      materialization: "failed",
      git: "not_committed",
      plannedPath: "conversations/000004-session.md",
    });
  });

  it("treats a recorded conversation commit as materialization proof", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    })).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "committed",
      plannedPath: "conversations/000004-session.md",
      materializedPath: "conversations/000004-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });
  });

  it("does not use a failed operation path or hash as committed materialization evidence", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: "conversations/000004-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
      materialization: {
        status: "failed",
        targetPath: "conversations/incorrect.md",
        contentHash: "sha256:failed-attempt",
      },
    })).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "committed",
      plannedPath: "conversations/000004-session.md",
      materializedPath: "conversations/000004-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });
  });

  it("omits blank optional evidence instead of exposing misleading identifiers", () => {
    expect(deriveConversationPersistenceState({
      plannedPath: " ",
      contentHash: "",
      committedSha: "\n",
    })).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
    });
  });
});
