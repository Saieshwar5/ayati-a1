import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { readConversationPersistenceState } from "../src/repositories/conversation-persistence-records.js";

const databases: ContextDatabase[] = [];
let database: ContextDatabase;

beforeEach(async () => {
  database = await ContextDatabase.open({ path: ":memory:" });
  databases.push(database);
  insertSession(database);
});

afterEach(() => {
  for (const item of databases.splice(0)) item.close();
});

describe("conversation persistence records", () => {
  it("returns no saved state for a missing conversation or a conversation without messages", () => {
    expect(readConversationPersistenceState(database, "missing")).toBeUndefined();

    insertConversation(database);

    expect(readConversationPersistenceState(database, "C-1")).toBeUndefined();
  });

  it("reports planned and hashed SQLite content as not requested", () => {
    insertSavedConversation(database, {
      contentHash: "sha256:calculated-content",
    });

    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
      contentHash: "sha256:calculated-content",
    });
  });

  it("reports the newest pending materialization without claiming a file exists", () => {
    insertSavedConversation(database);
    insertFileSync(database, {
      operationId: "SYNC-1",
      status: "pending",
      targetPath: "conversations/000001-session.md",
    });

    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "pending",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
    });
  });

  it("reports completed materialization from its durable target and hash", () => {
    insertSavedConversation(database, {
      contentHash: "sha256:conversation-row",
    });
    insertFileSync(database, {
      operationId: "SYNC-1",
      status: "completed",
      targetPath: "conversations/000001-session.md",
      contentHash: "sha256:materialized-file",
    });

    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
      materializedPath: "conversations/000001-session.md",
      contentHash: "sha256:materialized-file",
    });
  });

  it("fails closed for incomplete completed-operation evidence", () => {
    insertSavedConversation(database);
    insertFileSync(database, {
      operationId: "SYNC-1",
      status: "completed",
      targetPath: "conversations/000001-session.md",
    });

    expect(readConversationPersistenceState(database, "C-1")).toMatchObject({
      database: "saved",
      materialization: "failed",
      git: "not_committed",
    });
  });

  it("reports failed materialization separately from Git state", () => {
    insertSavedConversation(database);
    insertFileSync(database, {
      operationId: "SYNC-1",
      status: "failed",
      targetPath: "conversations/000001-session.md",
    });

    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "failed",
      git: "not_committed",
      plannedPath: "conversations/000001.pending.md",
    });
  });

  it("uses the newest operation rather than an older completed materialization", () => {
    insertSavedConversation(database);
    insertFileSync(database, {
      operationId: "SYNC-1",
      status: "completed",
      targetPath: "conversations/000001-first.md",
      contentHash: "sha256:first",
      createdAt: "2026-07-18T10:00:00+05:30",
    });
    insertFileSync(database, {
      operationId: "SYNC-2",
      status: "pending",
      targetPath: "conversations/000001-second.md",
      createdAt: "2026-07-18T10:01:00+05:30",
    });

    expect(readConversationPersistenceState(database, "C-1")).toMatchObject({
      materialization: "pending",
      git: "not_committed",
    });
  });

  it("treats a recorded conversation commit as committed materialization", () => {
    insertSavedConversation(database, {
      plannedPath: "conversations/000001-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });

    expect(readConversationPersistenceState(database, "C-1")).toEqual({
      database: "saved",
      materialization: "materialized",
      git: "committed",
      plannedPath: "conversations/000001-session.md",
      materializedPath: "conversations/000001-session.md",
      contentHash: "sha256:committed-content",
      committedSha: "abc123",
    });
  });
});

function insertSession(target: ContextDatabase): void {
  target.prepare([
    "INSERT INTO sessions(",
    "session_id, date, timezone, agent_id, repository_path, head_sha, status, created_at",
    ") VALUES ('S-1', '2026-07-18', 'Asia/Kolkata', 'local', '/sessions/S-1', NULL,",
    "'open', '2026-07-18T10:00:00+05:30')",
  ].join(" ")).run();
}

function insertSavedConversation(target: ContextDatabase, input?: {
  plannedPath?: string;
  contentHash?: string;
  committedSha?: string;
}): void {
  insertConversation(target, input);
  target.prepare([
    "INSERT INTO messages(",
    "message_id, conversation_id, session_id, session_sequence, segment_sequence,",
    "role, content, created_at",
    ") VALUES ('M-1', 'C-1', 'S-1', 1, 1, 'user', 'hello',",
    "'2026-07-18T10:00:00+05:30')",
  ].join(" ")).run();
}

function insertConversation(target: ContextDatabase, input?: {
  plannedPath?: string;
  contentHash?: string;
  committedSha?: string;
}): void {
  target.prepare([
    "INSERT INTO conversation_segments(",
    "conversation_id, session_id, sequence, file_path, status, content_hash,",
    "committed_sha, started_at",
    ") VALUES ('C-1', 'S-1', 1, ?, 'active', ?, ?,",
    "'2026-07-18T10:00:00+05:30')",
  ].join(" ")).run(
    input?.plannedPath ?? "conversations/000001.pending.md",
    input?.contentHash ?? null,
    input?.committedSha ?? null,
  );
}

function insertFileSync(target: ContextDatabase, input: {
  operationId: string;
  status: "pending" | "completed" | "failed";
  targetPath: string;
  contentHash?: string;
  createdAt?: string;
}): void {
  const requestId = "REQ-" + input.operationId;
  const createdAt = input.createdAt ?? "2026-07-18T10:00:00+05:30";
  target.prepare([
    "INSERT INTO idempotency_requests(",
    "request_id, operation, request_hash, status, response_json, created_at, completed_at",
    ") VALUES (?, 'append_conversation', 'hash', 'completed', '{}', ?, ?)",
  ].join(" ")).run(requestId, createdAt, createdAt);
  target.prepare([
    "INSERT INTO file_sync_operations(",
    "operation_id, request_id, session_id, conversation_id, target_path,",
    "expected_content_hash, status, created_at, completed_at",
    ") VALUES (?, ?, 'S-1', 'C-1', ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.operationId,
    requestId,
    input.targetPath,
    input.contentHash ?? null,
    input.status,
    createdAt,
    input.status === "completed" ? createdAt : null,
  );
}
