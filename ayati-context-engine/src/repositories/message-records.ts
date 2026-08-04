import { createHash } from "node:crypto";
import type {
  AssistantFeedbackKind,
  AssistantResponseKind,
  MessageAttachmentRef,
  MessageRole,
  StreamMessage,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { allocateStreamMessageSequence } from "./agent-stream-records.js";

interface MessageRow {
  message_id: string;
  stream_id: string;
  run_id: string;
  sequence: number;
  role: MessageRole;
  content: string;
  content_hash: string;
  created_at: string;
  response_kind: AssistantResponseKind | null;
  feedback_kind: AssistantFeedbackKind | null;
}

interface MessageAttachmentRow {
  message_id: string;
  resource_id: string;
  kind: MessageAttachmentRef["kind"];
  display_name: string;
}

interface AppendStreamMessageBase {
  streamId: string;
  runId: string;
  content: string;
  at: string;
}

type AppendStreamMessageInput = AppendStreamMessageBase & (
  | {
      role: "assistant";
      responseKind: AssistantResponseKind;
      feedbackKind?: AssistantFeedbackKind;
    }
  | {
      role: Exclude<MessageRole, "assistant">;
      responseKind?: never;
      feedbackKind?: never;
    }
);

export function appendStreamMessage(
  database: ContextDatabase,
  input: AppendStreamMessageInput,
): StreamMessage {
  if (input.role === "assistant"
    && input.feedbackKind
    && input.responseKind !== "feedback") {
    throw new Error("Assistant feedback kind requires a feedback response.");
  }
  const sequence = allocateStreamMessageSequence(database, input.streamId, input.at);
  const messageId = messageIdentity(input.streamId, sequence);
  const contentHash = createHash("sha256").update(input.content).digest("hex");
  database.prepare([
    "INSERT INTO messages(message_id, stream_id, run_id, sequence, role, content, content_hash, created_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    messageId,
    input.streamId,
    input.runId,
    sequence,
    input.role,
    input.content,
    contentHash,
    input.at,
  );
  database.prepare([
    "INSERT INTO message_search(message_id, stream_id, content) VALUES (?, ?, ?)",
  ].join(" ")).run(messageId, input.streamId, input.content);
  if (input.role === "assistant") {
    database.prepare([
      "INSERT INTO message_response_metadata(message_id, response_kind, feedback_kind)",
      "VALUES (?, ?, ?)",
    ].join(" ")).run(
      messageId,
      input.responseKind,
      input.feedbackKind ?? null,
    );
  }
  return {
    messageId,
    streamId: input.streamId,
    runId: input.runId,
    sequence,
    role: input.role,
    content: input.content,
    contentHash,
    at: input.at,
    ...(input.role === "assistant" ? {
      responseKind: input.responseKind,
      ...(input.feedbackKind ? { feedbackKind: input.feedbackKind } : {}),
    } : {}),
  };
}

export function readStreamMessage(
  database: ContextDatabase,
  messageId: string,
): StreamMessage | undefined {
  const row = database.prepare(messageSelect() + " WHERE m.message_id = ?")
    .get(messageId) as MessageRow | undefined;
  return row ? streamMessages(database, [row])[0] : undefined;
}

export function readRunMessages(database: ContextDatabase, runId: string): StreamMessage[] {
  const rows = database.prepare(messageSelect() + " WHERE m.run_id = ? ORDER BY m.sequence")
    .all(runId) as unknown as MessageRow[];
  return streamMessages(database, rows);
}

export function readRunIngressMessage(
  database: ContextDatabase,
  runId: string,
): StreamMessage | undefined {
  const row = database.prepare([
    messageSelect(),
    "WHERE m.run_id = ? AND m.role IN ('user', 'system_event') LIMIT 1",
  ].join(" ")).get(runId) as MessageRow | undefined;
  return row ? streamMessages(database, [row])[0] : undefined;
}

export function readStreamMessages(database: ContextDatabase, input: {
  streamId: string;
  afterSeq?: number;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}): StreamMessage[] {
  const clauses = ["m.stream_id = ?"];
  const params: Array<string | number> = [input.streamId];
  if (input.afterSeq !== undefined) {
    clauses.push("m.sequence > ?");
    params.push(input.afterSeq);
  }
  if (input.fromSeq !== undefined) {
    clauses.push("m.sequence >= ?");
    params.push(input.fromSeq);
  }
  if (input.toSeq !== undefined) {
    clauses.push("m.sequence <= ?");
    params.push(input.toSeq);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 500, 10_000));
  params.push(limit);
  const rows = database.prepare([
    messageSelect(),
    "WHERE " + clauses.join(" AND "),
    "ORDER BY m.sequence LIMIT ?",
  ].join(" ")).all(...params) as unknown as MessageRow[];
  return streamMessages(database, rows);
}

export function readRecentStreamMessages(database: ContextDatabase, input: {
  streamId: string;
  afterSeq?: number;
  limit: number;
}): StreamMessage[] {
  const clauses = ["m.stream_id = ?"];
  const params: Array<string | number> = [input.streamId];
  if (input.afterSeq !== undefined) {
    clauses.push("m.sequence > ?");
    params.push(input.afterSeq);
  }
  const limit = Math.max(1, Math.min(input.limit, 10_000));
  params.push(limit);
  const rows = database.prepare([
    messageSelect(),
    "WHERE " + clauses.join(" AND "),
    "ORDER BY m.sequence DESC LIMIT ?",
  ].join(" ")).all(...params) as unknown as MessageRow[];
  return streamMessages(database, rows.reverse());
}

export function readStreamMessagesBefore(database: ContextDatabase, input: {
  streamId: string;
  snapshotToSeq: number;
  beforeSeq: number;
  limit: number;
}): StreamMessage[] {
  const limit = Math.max(1, Math.min(input.limit, 10_000));
  const rows = database.prepare([
    messageSelect(),
    "WHERE m.stream_id = ? AND m.sequence <= ? AND m.sequence < ?",
    "ORDER BY m.sequence DESC LIMIT ?",
  ].join(" ")).all(
    input.streamId,
    input.snapshotToSeq,
    input.beforeSeq,
    limit,
  ) as unknown as MessageRow[];
  return streamMessages(database, rows);
}

export function searchStreamMessages(database: ContextDatabase, input: {
  streamId: string;
  query: string;
  limit: number;
}): StreamMessage[] {
  const query = ftsQuery(input.query);
  if (!query) return [];
  const rows = database.prepare([
    "SELECT m.message_id, m.stream_id, m.run_id, m.sequence, m.role, m.content,",
    "m.content_hash, m.created_at, metadata.response_kind, metadata.feedback_kind",
    "FROM message_search s",
    "JOIN messages m ON m.message_id = s.message_id",
    "LEFT JOIN message_response_metadata metadata ON metadata.message_id = m.message_id",
    "WHERE s.stream_id = ? AND message_search MATCH ?",
    "ORDER BY bm25(message_search), m.sequence DESC LIMIT ?",
  ].join(" ")).all(input.streamId, query, input.limit) as unknown as MessageRow[];
  return streamMessages(database, rows);
}

function streamMessages(
  database: ContextDatabase,
  rows: MessageRow[],
): StreamMessage[] {
  const attachments = readMessageAttachments(
    database,
    rows.map((row) => row.message_id),
  );
  return rows.map((row) => {
    const attachmentRefs = attachments.get(row.message_id);
    return {
      ...streamMessage(row),
      ...(attachmentRefs && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
    };
  });
}

function streamMessage(row: MessageRow): StreamMessage {
  return {
    messageId: row.message_id,
    streamId: row.stream_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    role: row.role,
    content: row.content,
    contentHash: row.content_hash,
    at: row.created_at,
    ...(row.response_kind ? { responseKind: row.response_kind } : {}),
    ...(row.feedback_kind ? { feedbackKind: row.feedback_kind } : {}),
  };
}

function readMessageAttachments(
  database: ContextDatabase,
  messageIds: string[],
): Map<string, MessageAttachmentRef[]> {
  const result = new Map<string, MessageAttachmentRef[]>();
  for (let start = 0; start < messageIds.length; start += 250) {
    const chunk = messageIds.slice(start, start + 250);
    if (chunk.length === 0) continue;
    const rows = database.prepare([
      "SELECT mr.message_id, r.resource_id, r.kind, r.display_name",
      "FROM message_resources mr",
      "JOIN resources r ON r.resource_id = mr.resource_id",
      `WHERE mr.role = 'attachment' AND mr.message_id IN (${chunk.map(() => "?").join(", ")})`,
      "ORDER BY mr.message_id, mr.ordinal, r.resource_id",
    ].join(" ")).all(...chunk) as unknown as MessageAttachmentRow[];
    for (const row of rows) {
      const refs = result.get(row.message_id) ?? [];
      refs.push({
        resourceId: row.resource_id,
        kind: row.kind,
        displayName: row.display_name,
      });
      result.set(row.message_id, refs);
    }
  }
  return result;
}

function messageIdentity(streamId: string, sequence: number): string {
  const streamPart = createHash("sha256").update(streamId).digest("hex").slice(0, 8).toUpperCase();
  return "MSG-" + streamPart + "-" + String(sequence).padStart(10, "0");
}

function messageSelect(): string {
  return [
    "SELECT m.message_id, m.stream_id, m.run_id, m.sequence, m.role, m.content,",
    "m.content_hash, m.created_at, metadata.response_kind, metadata.feedback_kind",
    "FROM messages m",
    "LEFT JOIN message_response_metadata metadata ON metadata.message_id = m.message_id",
  ].join(" ");
}

function ftsQuery(value: string): string | undefined {
  const terms = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const query = terms.slice(0, 20).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  return query || undefined;
}
