import type { ContextDatabase } from "../database/database.js";
import type {
  AppendConversationRequest,
  ConversationRef,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";

interface ConversationRow {
  conversation_id: string;
  session_id: string;
  sequence: number;
  file_path: string;
  status: ConversationRef["status"];
}

export function appendConversationMessage(
  database: ContextDatabase,
  input: AppendConversationRequest,
): ConversationRef {
  const conversation = input.role === "assistant"
    ? requireActiveConversation(database, input.sessionId)
    : createConversationForNewInput(database, input);
  const sessionSequence = nextNumber(database, [
    "SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next",
    "FROM messages WHERE session_id = ?",
  ].join(" "), input.sessionId);
  const segmentSequence = nextNumber(database, [
    "SELECT COALESCE(MAX(segment_sequence), 0) + 1 AS next",
    "FROM messages WHERE conversation_id = ?",
  ].join(" "), conversation.conversationId);
  const messageId = input.sessionId + "-M-" + pad(sessionSequence, 6);

  database.prepare([
    "INSERT INTO messages(",
    "message_id, conversation_id, session_id, session_sequence,",
    "segment_sequence, role, content, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    messageId,
    conversation.conversationId,
    input.sessionId,
    sessionSequence,
    segmentSequence,
    input.role,
    input.content,
    input.at,
  );

  if (input.runId || input.taskId) {
    database.prepare([
      "UPDATE conversation_segments",
      "SET run_id = COALESCE(?, run_id), task_id = COALESCE(?, task_id)",
      "WHERE conversation_id = ?",
    ].join(" ")).run(
      input.runId ?? null,
      input.taskId ?? null,
      conversation.conversationId,
    );
  }
  return conversation;
}

export function readConversation(
  database: ContextDatabase,
  conversationId: string,
): ConversationRef | undefined {
  const row = database.prepare([
    "SELECT conversation_id, session_id, sequence, file_path, status",
    "FROM conversation_segments WHERE conversation_id = ?",
  ].join(" ")).get(conversationId) as ConversationRow | undefined;
  return row ? conversationRef(row) : undefined;
}

export function readPendingConversations(
  database: ContextDatabase,
  sessionId: string,
): ConversationRef[] {
  const rows = database.prepare([
    "SELECT conversation_id, session_id, sequence, file_path, status",
    "FROM conversation_segments",
    "WHERE session_id = ? AND status IN ('active', 'closed')",
    "ORDER BY sequence",
  ].join(" ")).all(sessionId) as unknown as ConversationRow[];
  return rows.map(conversationRef);
}

export function bindConversationRun(
  database: ContextDatabase,
  conversationId: string,
  runId: string,
): void {
  database.prepare([
    "UPDATE conversation_segments SET run_id = ? WHERE conversation_id = ?",
  ].join(" ")).run(runId, conversationId);
}

function createConversationForNewInput(
  database: ContextDatabase,
  input: AppendConversationRequest,
): ConversationRef {
  const activeRun = database.prepare([
    "SELECT run_id FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1",
  ].join(" ")).get(input.sessionId) as { run_id: string } | undefined;
  if (activeRun) {
    throw new GitContextServiceError({
      code: "RUN_ALREADY_ACTIVE",
      message: "Session already has an active run.",
      details: { sessionId: input.sessionId, runId: activeRun.run_id },
    });
  }

  database.prepare([
    "UPDATE conversation_segments",
    "SET status = 'closed', closed_at = ?",
    "WHERE session_id = ? AND status = 'active'",
  ].join(" ")).run(input.at, input.sessionId);

  const sequence = nextNumber(database, [
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next",
    "FROM conversation_segments WHERE session_id = ?",
  ].join(" "), input.sessionId);
  const conversationId = input.sessionId + "-C-" + pad(sequence, 6);
  const filePath = "conversations/" + pad(sequence, 6) + ".pending.md";
  database.prepare([
    "INSERT INTO conversation_segments(",
    "conversation_id, session_id, sequence, file_path, task_id, run_id, status,",
    "content_hash, committed_sha, started_at, closed_at",
    ") VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, NULL)",
  ].join(" ")).run(
    conversationId,
    input.sessionId,
    sequence,
    filePath,
    input.taskId ?? null,
    input.runId ?? null,
    input.at,
  );
  return {
    conversationId,
    sessionId: input.sessionId,
    sequence,
    filePath,
    status: "active",
  };
}

function requireActiveConversation(
  database: ContextDatabase,
  sessionId: string,
): ConversationRef {
  const row = database.prepare([
    "SELECT conversation_id, session_id, sequence, file_path, status",
    "FROM conversation_segments",
    "WHERE session_id = ? AND status = 'active'",
    "ORDER BY sequence DESC LIMIT 1",
  ].join(" ")).get(sessionId) as ConversationRow | undefined;
  if (!row) {
    throw new GitContextServiceError({
      code: "CONVERSATION_NOT_ACTIVE",
      message: "Assistant message requires an active conversation segment.",
      details: { sessionId },
    });
  }
  return conversationRef(row);
}

function nextNumber(database: ContextDatabase, sql: string, value: string): number {
  const row = database.prepare(sql).get(value) as { next: number };
  return Number(row.next);
}

function conversationRef(row: ConversationRow): ConversationRef {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    filePath: row.file_path,
    status: row.status,
  };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
