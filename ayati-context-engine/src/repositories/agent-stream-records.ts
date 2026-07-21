import { createHash } from "node:crypto";
import type { AgentStreamRef } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface AgentStreamRow {
  stream_id: string;
  agent_id: string;
  scope_key: string;
  last_message_sequence: number;
  last_run_sequence: number;
  active_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
}

export function ensureAgentStream(database: ContextDatabase, input: {
  agentId: string;
  scopeKey: string;
  at: string;
}): { stream: AgentStreamRef; created: boolean } {
  const existing = readAgentStreamByScope(database, input.agentId, input.scopeKey);
  if (existing) return { stream: existing, created: false };

  const streamId = streamIdentity(input.agentId, input.scopeKey);
  database.prepare([
    "INSERT INTO agent_streams(",
    "stream_id, agent_id, scope_key, last_message_sequence, last_run_sequence,",
    "active_checkpoint_id, created_at, updated_at",
    ") VALUES (?, ?, ?, 0, 0, NULL, ?, ?)",
  ].join(" ")).run(streamId, input.agentId, input.scopeKey, input.at, input.at);
  const stream = readAgentStream(database, streamId);
  if (!stream) throw new Error("Inserted agent stream could not be read: " + streamId);
  return { stream, created: true };
}

export function readAgentStream(
  database: ContextDatabase,
  streamId: string,
): AgentStreamRef | undefined {
  const row = database.prepare(streamSelect() + " WHERE stream_id = ?")
    .get(streamId) as AgentStreamRow | undefined;
  return row ? streamRef(row) : undefined;
}

export function readAgentStreamByScope(
  database: ContextDatabase,
  agentId: string,
  scopeKey: string,
): AgentStreamRef | undefined {
  const row = database.prepare(streamSelect() + " WHERE agent_id = ? AND scope_key = ?")
    .get(agentId, scopeKey) as AgentStreamRow | undefined;
  return row ? streamRef(row) : undefined;
}

export function readLatestAgentStream(database: ContextDatabase): AgentStreamRef | undefined {
  const row = database.prepare(streamSelect() + " ORDER BY updated_at DESC LIMIT 1")
    .get() as AgentStreamRow | undefined;
  return row ? streamRef(row) : undefined;
}

export function allocateStreamRunSequence(
  database: ContextDatabase,
  streamId: string,
  at: string,
): number {
  const result = database.prepare([
    "UPDATE agent_streams SET last_run_sequence = last_run_sequence + 1, updated_at = ?",
    "WHERE stream_id = ? RETURNING last_run_sequence",
  ].join(" ")).get(at, streamId) as { last_run_sequence: number } | undefined;
  if (!result) throw new Error("Agent stream does not exist: " + streamId);
  return Number(result.last_run_sequence);
}

export function allocateStreamMessageSequence(
  database: ContextDatabase,
  streamId: string,
  at: string,
): number {
  const result = database.prepare([
    "UPDATE agent_streams SET last_message_sequence = last_message_sequence + 1, updated_at = ?",
    "WHERE stream_id = ? RETURNING last_message_sequence",
  ].join(" ")).get(at, streamId) as { last_message_sequence: number } | undefined;
  if (!result) throw new Error("Agent stream does not exist: " + streamId);
  return Number(result.last_message_sequence);
}

export function setActiveCheckpoint(
  database: ContextDatabase,
  streamId: string,
  checkpointId: string,
  expectedPreviousCheckpointId: string | undefined,
  at: string,
): void {
  const result = database.prepare([
    "UPDATE agent_streams SET active_checkpoint_id = ?, updated_at = ?",
    "WHERE stream_id = ? AND active_checkpoint_id IS ?",
  ].join(" ")).run(checkpointId, at, streamId, expectedPreviousCheckpointId ?? null);
  if (Number(result.changes) !== 1) {
    throw new Error("Agent stream checkpoint pointer changed before commit.");
  }
}

function streamIdentity(agentId: string, scopeKey: string): string {
  const digest = createHash("sha256").update(agentId + "\0" + scopeKey).digest("hex").slice(0, 20);
  return "AST-" + digest.toUpperCase();
}

function streamRef(row: AgentStreamRow): AgentStreamRef {
  return {
    streamId: row.stream_id,
    agentId: row.agent_id,
    scopeKey: row.scope_key,
    lastMessageSequence: Number(row.last_message_sequence),
    lastRunSequence: Number(row.last_run_sequence),
    ...(row.active_checkpoint_id ? { activeCheckpointId: row.active_checkpoint_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function streamSelect(): string {
  return [
    "SELECT stream_id, agent_id, scope_key, last_message_sequence, last_run_sequence,",
    "active_checkpoint_id, created_at, updated_at FROM agent_streams",
  ].join(" ");
}
