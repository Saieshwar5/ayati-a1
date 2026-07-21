import { createHash } from "node:crypto";
import type { MessageRole, StreamMessage } from "../contracts.js";
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
}

export function appendStreamMessage(database: ContextDatabase, input: {
  streamId: string;
  runId: string;
  role: MessageRole;
  content: string;
  at: string;
}): StreamMessage {
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
  return {
    messageId,
    streamId: input.streamId,
    runId: input.runId,
    sequence,
    role: input.role,
    content: input.content,
    contentHash,
    at: input.at,
  };
}

export function readStreamMessage(
  database: ContextDatabase,
  messageId: string,
): StreamMessage | undefined {
  const row = database.prepare(messageSelect() + " WHERE message_id = ?")
    .get(messageId) as MessageRow | undefined;
  return row ? streamMessage(row) : undefined;
}

export function readRunMessages(database: ContextDatabase, runId: string): StreamMessage[] {
  const rows = database.prepare(messageSelect() + " WHERE run_id = ? ORDER BY sequence")
    .all(runId) as unknown as MessageRow[];
  return rows.map(streamMessage);
}

export function readStreamMessages(database: ContextDatabase, input: {
  streamId: string;
  afterSeq?: number;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
}): StreamMessage[] {
  const clauses = ["stream_id = ?"];
  const params: Array<string | number> = [input.streamId];
  if (input.afterSeq !== undefined) {
    clauses.push("sequence > ?");
    params.push(input.afterSeq);
  }
  if (input.fromSeq !== undefined) {
    clauses.push("sequence >= ?");
    params.push(input.fromSeq);
  }
  if (input.toSeq !== undefined) {
    clauses.push("sequence <= ?");
    params.push(input.toSeq);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 500, 10_000));
  params.push(limit);
  const rows = database.prepare([
    messageSelect(),
    "WHERE " + clauses.join(" AND "),
    "ORDER BY sequence LIMIT ?",
  ].join(" ")).all(...params) as unknown as MessageRow[];
  return rows.map(streamMessage);
}

export function readRecentStreamMessages(database: ContextDatabase, input: {
  streamId: string;
  afterSeq?: number;
  limit: number;
}): StreamMessage[] {
  const clauses = ["stream_id = ?"];
  const params: Array<string | number> = [input.streamId];
  if (input.afterSeq !== undefined) {
    clauses.push("sequence > ?");
    params.push(input.afterSeq);
  }
  const limit = Math.max(1, Math.min(input.limit, 10_000));
  params.push(limit);
  const rows = database.prepare([
    messageSelect(),
    "WHERE " + clauses.join(" AND "),
    "ORDER BY sequence DESC LIMIT ?",
  ].join(" ")).all(...params) as unknown as MessageRow[];
  return rows.reverse().map(streamMessage);
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
    "m.content_hash, m.created_at FROM message_search s",
    "JOIN messages m ON m.message_id = s.message_id",
    "WHERE s.stream_id = ? AND message_search MATCH ?",
    "ORDER BY bm25(message_search), m.sequence DESC LIMIT ?",
  ].join(" ")).all(input.streamId, query, input.limit) as unknown as MessageRow[];
  return rows.map(streamMessage);
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
  };
}

function messageIdentity(streamId: string, sequence: number): string {
  const streamPart = createHash("sha256").update(streamId).digest("hex").slice(0, 8).toUpperCase();
  return "MSG-" + streamPart + "-" + String(sequence).padStart(10, "0");
}

function messageSelect(): string {
  return [
    "SELECT message_id, stream_id, run_id, sequence, role, content, content_hash, created_at",
    "FROM messages",
  ].join(" ");
}

function ftsQuery(value: string): string | undefined {
  const terms = value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const query = terms.slice(0, 20).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  return query || undefined;
}
