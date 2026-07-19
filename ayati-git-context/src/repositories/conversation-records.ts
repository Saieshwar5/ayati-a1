import type { ContextDatabase } from "../database/database.js";
import type {
  ConversationContext,
  ConversationMessage,
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

interface ConversationMessageRow {
  message_id: string;
  conversation_id: string;
  session_sequence: number;
  segment_sequence: number;
  role: ConversationMessage["role"];
  content: string;
  created_at: string;
}

export interface AppendIngressConversationInput {
  sessionId: string;
  role: "user" | "system_event";
  content: string;
  at: string;
}

export function appendConversationMessage(
  database: ContextDatabase,
  input: AppendIngressConversationInput,
): { conversation: ConversationRef; message: ConversationMessage } {
  closeActiveConversation(database, input.sessionId, input.at);
  const conversation = createConversationForNewInput(database, input);
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

  return {
    conversation,
    message: {
      messageId,
      conversationId: conversation.conversationId,
      sessionSequence,
      segmentSequence,
      role: input.role,
      content: input.content,
      at: input.at,
    },
  };
}

export function readConversationMessages(
  database: ContextDatabase,
  conversationId: string,
): ConversationMessage[] {
  const rows = database.prepare([
    "SELECT message_id, conversation_id, session_sequence, segment_sequence,",
    "role, content, created_at FROM messages",
    "WHERE conversation_id = ? ORDER BY segment_sequence",
  ].join(" ")).all(conversationId) as unknown as ConversationMessageRow[];
  return rows.map(conversationMessage);
}

export function readConversationMessage(
  database: ContextDatabase,
  messageId: string,
): ConversationMessage | undefined {
  const row = database.prepare([
    "SELECT message_id, conversation_id, session_sequence, segment_sequence,",
    "role, content, created_at FROM messages WHERE message_id = ?",
  ].join(" ")).get(messageId) as ConversationMessageRow | undefined;
  return row ? conversationMessage(row) : undefined;
}

export function readLatestConversationMessage(
  database: ContextDatabase,
  conversationId: string,
): ConversationMessage | undefined {
  const row = database.prepare([
    "SELECT message_id, conversation_id, session_sequence, segment_sequence,",
    "role, content, created_at FROM messages",
    "WHERE conversation_id = ? ORDER BY segment_sequence DESC LIMIT 1",
  ].join(" ")).get(conversationId) as ConversationMessageRow | undefined;
  return row ? conversationMessage(row) : undefined;
}

export function readPendingConversationContexts(
  database: ContextDatabase,
  sessionId: string,
): ConversationContext[] {
  return readPendingConversations(database, sessionId).map((conversation) => ({
    conversation,
    messages: readConversationMessages(database, conversation.conversationId),
    contentHash: readConversationContentHash(database, conversation.conversationId) ?? "",
  }));
}

export function updateConversationContentHash(
  database: ContextDatabase,
  conversationId: string,
  contentHash: string,
): void {
  database.prepare([
    "UPDATE conversation_segments SET content_hash = ? WHERE conversation_id = ?",
  ].join(" ")).run(contentHash, conversationId);
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

export function readConversationBinding(
  database: ContextDatabase,
  conversationId: string,
): { runId?: string; taskId?: string } | undefined {
  const row = database.prepare([
    "SELECT run_id, task_id FROM conversation_segments WHERE conversation_id = ?",
  ].join(" ")).get(conversationId) as {
    run_id: string | null;
    task_id: string | null;
  } | undefined;
  return row
    ? {
        ...(row.run_id ? { runId: row.run_id } : {}),
        ...(row.task_id ? { taskId: row.task_id } : {}),
      }
    : undefined;
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

export function closeRunConversationWithAssistant(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  runId: string;
  taskId?: string;
  content: string;
  at: string;
}): ConversationRef {
  const row = requireRunConversation(database, input);
  const sessionSequence = nextNumber(database, [
    "SELECT COALESCE(MAX(session_sequence), 0) + 1 AS next",
    "FROM messages WHERE session_id = ?",
  ].join(" "), input.sessionId);
  const segmentSequence = nextNumber(database, [
    "SELECT COALESCE(MAX(segment_sequence), 0) + 1 AS next",
    "FROM messages WHERE conversation_id = ?",
  ].join(" "), input.conversationId);
  database.prepare([
    "INSERT INTO messages(message_id, conversation_id, session_id, session_sequence,",
    "segment_sequence, role, content, created_at) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?)",
  ].join(" ")).run(
    input.sessionId + "-M-" + pad(sessionSequence, 6), input.conversationId,
    input.sessionId, sessionSequence, segmentSequence, input.content, input.at,
  );
  const filePath = "conversations/" + pad(Number(row.sequence), 6)
    + (input.taskId ? "-task-" + input.taskId : "-unbound") + ".md";
  return closeRunConversation(database, input, row, filePath);
}

export function closeRunConversationWithoutAssistant(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  runId: string;
  taskId?: string;
  at: string;
}): ConversationRef {
  const row = requireRunConversation(database, input);
  const filePath = "conversations/" + pad(Number(row.sequence), 6)
    + (input.taskId ? "-task-" + input.taskId : "-unbound") + ".md";
  return closeRunConversation(database, input, row, filePath);
}

function requireRunConversation(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  runId: string;
  taskId?: string;
}): ConversationRow {
  const row = database.prepare([
    "SELECT conversation_id, session_id, sequence, file_path, status, task_id",
    "FROM conversation_segments",
    "WHERE conversation_id = ? AND session_id = ? AND run_id = ?",
  ].join(" ")).get(
    input.conversationId, input.sessionId, input.runId,
  ) as (ConversationRow & { task_id: string | null }) | undefined;
  if (!row || row.status !== "active" || (row.task_id ?? undefined) !== input.taskId) {
    throw new GitContextServiceError({
      code: "CONVERSATION_NOT_ACTIVE",
      message: "Run finalization requires its matching active conversation.",
      details: { conversationId: input.conversationId, runId: input.runId },
    });
  }
  return row;
}

function closeRunConversation(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  at: string;
}, row: ConversationRow, filePath: string): ConversationRef {
  database.prepare([
    "UPDATE conversation_segments SET status = 'closed', closed_at = ?, file_path = ?",
    "WHERE conversation_id = ?",
  ].join(" ")).run(input.at, filePath, input.conversationId);
  return {
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    sequence: Number(row.sequence),
    filePath,
    status: "closed",
  };
}

export function markPendingConversationsCommitted(
  database: ContextDatabase,
  sessionId: string,
  commit: string,
): void {
  database.prepare([
    "UPDATE conversation_segments SET status = 'committed', committed_sha = ?",
    "WHERE session_id = ? AND status = 'closed'",
  ].join(" ")).run(commit, sessionId);
}

function conversationMessage(row: ConversationMessageRow): ConversationMessage {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    sessionSequence: Number(row.session_sequence),
    segmentSequence: Number(row.segment_sequence),
    role: row.role,
    content: row.content,
    at: row.created_at,
  };
}

function createConversationForNewInput(
  database: ContextDatabase,
  input: AppendIngressConversationInput,
): ConversationRef {
  const activeRun = database.prepare([
    "SELECT run_id FROM runs",
    "WHERE session_id = ? AND status IN ('running', 'recovery_required') LIMIT 1",
  ].join(" ")).get(input.sessionId) as { run_id: string } | undefined;
  if (activeRun) {
    throw new GitContextServiceError({
      code: "RUN_ALREADY_ACTIVE",
      message: "Session already has an active or recovery-required run.",
      details: { sessionId: input.sessionId, runId: activeRun.run_id },
    });
  }

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
    null,
    null,
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

function closeActiveConversation(
  database: ContextDatabase,
  sessionId: string,
  at: string,
): ConversationRef | undefined {
  const active = requireActiveConversationIfPresent(database, sessionId);
  if (!active) {
    return undefined;
  }
  const closedPath = "conversations/" + pad(active.sequence, 6) + "-session.md";
  database.prepare([
    "UPDATE conversation_segments",
    "SET status = 'closed', closed_at = ?, file_path = ?",
    "WHERE conversation_id = ?",
  ].join(" ")).run(at, closedPath, active.conversationId);
  return { ...active, filePath: closedPath, status: "closed" };
}

function requireActiveConversationIfPresent(
  database: ContextDatabase,
  sessionId: string,
): ConversationRef | undefined {
  const row = database.prepare([
    "SELECT conversation_id, session_id, sequence, file_path, status",
    "FROM conversation_segments WHERE session_id = ? AND status = 'active'",
    "ORDER BY sequence DESC LIMIT 1",
  ].join(" ")).get(sessionId) as ConversationRow | undefined;
  return row ? conversationRef(row) : undefined;
}

export function readConversationContentHash(
  database: ContextDatabase,
  conversationId: string,
): string | undefined {
  const row = database.prepare([
    "SELECT content_hash FROM conversation_segments WHERE conversation_id = ?",
  ].join(" ")).get(conversationId) as { content_hash: string | null } | undefined;
  return row?.content_hash ?? undefined;
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
