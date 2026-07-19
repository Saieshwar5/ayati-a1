import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { readConversationPersistenceState } from "../src/repositories/conversation-persistence-records.js";

const databases: ContextDatabase[] = [];
let database: ContextDatabase;

beforeEach(async () => {
  database = await ContextDatabase.open({ path: ":memory:" });
  databases.push(database);
  database.prepare([
    "INSERT INTO sessions(",
    "session_id, date, timezone, agent_id, repository_path, head_sha, status, created_at",
    ") VALUES ('S-1', '2026-07-19', 'Asia/Kolkata', 'local', '/sessions/S-1', NULL,",
    "'open', '2026-07-19T10:00:00+05:30')",
  ].join(" ")).run();
});

afterEach(() => {
  for (const item of databases.splice(0)) item.close();
});

describe("conversation persistence records", () => {
  it("requires both a conversation and at least one durable message", () => {
    expect(readConversationPersistenceState(database, "missing")).toBeUndefined();
    insertConversation();
    expect(readConversationPersistenceState(database, "C-1")).toBeUndefined();
  });

  it("reports database-only conversation state without compatibility materialization", () => {
    insertSavedConversation({ contentHash: "sha256:calculated-content" });
    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
      contentHash: "sha256:calculated-content",
    });
  });

  it("treats authoritative committed conversation evidence as materialized", () => {
    insertSavedConversation({
      plannedPath: "conversations/000001-unbound.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });
    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "committed",
      plannedPath: "conversations/000001-unbound.md",
      materializedPath: "conversations/000001-unbound.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });
  });
});

function insertSavedConversation(input?: {
  plannedPath?: string;
  contentHash?: string;
  committedSha?: string;
}): void {
  insertConversation(input);
  database.prepare([
    "INSERT INTO messages(",
    "message_id, conversation_id, session_id, session_sequence, segment_sequence,",
    "role, content, created_at",
    ") VALUES ('M-1', 'C-1', 'S-1', 1, 1, 'user', 'hello',",
    "'2026-07-19T10:00:00+05:30')",
  ].join(" ")).run();
}

function insertConversation(input?: {
  plannedPath?: string;
  contentHash?: string;
  committedSha?: string;
}): void {
  database.prepare([
    "INSERT INTO conversation_segments(",
    "conversation_id, session_id, sequence, file_path, status, content_hash,",
    "committed_sha, started_at",
    ") VALUES ('C-1', 'S-1', 1, ?, 'active', ?, ?,",
    "'2026-07-19T10:00:00+05:30')",
  ].join(" ")).run(
    input?.plannedPath ?? "conversations/000001.pending.md",
    input?.contentHash ?? null,
    input?.committedSha ?? null,
  );
}
