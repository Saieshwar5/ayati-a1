import { createHash } from "node:crypto";
import type {
  ContextCheckpointRecord,
  ContextCheckpointSummary,
  StreamMessage,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface ContextCheckpointRow {
  checkpoint_id: string;
  stream_id: string;
  previous_checkpoint_id: string | null;
  covered_from_seq: number;
  covered_to_seq: number;
  source_hash: string;
  schema_version: 1;
  summary_json: string;
  exact_anchors_json: string;
  token_count: number;
  reason: "context_pressure";
  provider: string;
  model: string;
  created_at: string;
}

export function readContextCheckpoint(
  database: ContextDatabase,
  checkpointId: string,
): ContextCheckpointRecord | undefined {
  const row = database.prepare(checkpointSelect() + " WHERE checkpoint_id = ?")
    .get(checkpointId) as ContextCheckpointRow | undefined;
  return row ? checkpointRecord(row) : undefined;
}

export function readActiveContextCheckpoint(
  database: ContextDatabase,
  streamId: string,
): ContextCheckpointRecord | undefined {
  const row = database.prepare([
    checkpointSelect("c"),
    "JOIN agent_streams s ON s.active_checkpoint_id = c.checkpoint_id",
    "WHERE s.stream_id = ?",
  ].join(" ")).get(streamId) as ContextCheckpointRow | undefined;
  return row ? checkpointRecord(row) : undefined;
}

export function insertContextCheckpoint(database: ContextDatabase, input: {
  streamId: string;
  previousCheckpointId?: string;
  coveredFromSeq: number;
  coveredToSeq: number;
  sourceHash: string;
  summary: ContextCheckpointSummary;
  exactAnchors: number[];
  tokenCount: number;
  provider: string;
  model: string;
  at: string;
}): ContextCheckpointRecord {
  const checkpointId = checkpointIdentity(
    input.streamId,
    input.coveredFromSeq,
    input.coveredToSeq,
    input.sourceHash,
  );
  database.prepare([
    "INSERT INTO context_checkpoints(",
    "checkpoint_id, stream_id, previous_checkpoint_id, covered_from_seq, covered_to_seq,",
    "source_hash, schema_version, summary_json, exact_anchors_json, token_count, reason,",
    "provider, model, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'context_pressure', ?, ?, ?)",
  ].join(" ")).run(
    checkpointId,
    input.streamId,
    input.previousCheckpointId ?? null,
    input.coveredFromSeq,
    input.coveredToSeq,
    input.sourceHash,
    JSON.stringify(input.summary),
    JSON.stringify(input.exactAnchors),
    input.tokenCount,
    input.provider,
    input.model,
    input.at,
  );
  const record = readContextCheckpoint(database, checkpointId);
  if (!record) throw new Error("Inserted context checkpoint could not be read: " + checkpointId);
  return record;
}

export function contextCheckpointSourceHash(input: {
  previousCheckpoint?: ContextCheckpointRecord;
  messages: StreamMessage[];
}): string {
  const previous = input.previousCheckpoint
    ? {
        checkpointId: input.previousCheckpoint.checkpointId,
        sourceHash: input.previousCheckpoint.sourceHash,
        coveredFromSeq: input.previousCheckpoint.coveredFromSeq,
        coveredToSeq: input.previousCheckpoint.coveredToSeq,
        summary: input.previousCheckpoint.summary,
        exactAnchors: input.previousCheckpoint.exactAnchors,
      }
    : null;
  const messages = input.messages.map((message) => ({
    messageId: message.messageId,
    runId: message.runId,
    sequence: message.sequence,
    role: message.role,
    contentHash: message.contentHash,
    content: message.content,
    at: message.at,
  }));
  return createHash("sha256")
    .update(canonicalJson({ previous, messages }))
    .digest("hex");
}

function checkpointIdentity(
  streamId: string,
  coveredFromSeq: number,
  coveredToSeq: number,
  sourceHash: string,
): string {
  const digest = createHash("sha256")
    .update([streamId, coveredFromSeq, coveredToSeq, sourceHash].join("\0"))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return "CHK-" + digest;
}

function checkpointSelect(alias?: string): string {
  const prefix = alias ? alias + "." : "";
  return [
    "SELECT",
    prefix + "checkpoint_id AS checkpoint_id,",
    prefix + "stream_id AS stream_id,",
    prefix + "previous_checkpoint_id AS previous_checkpoint_id,",
    prefix + "covered_from_seq AS covered_from_seq,",
    prefix + "covered_to_seq AS covered_to_seq,",
    prefix + "source_hash AS source_hash,",
    prefix + "schema_version AS schema_version,",
    prefix + "summary_json AS summary_json,",
    prefix + "exact_anchors_json AS exact_anchors_json,",
    prefix + "token_count AS token_count,",
    prefix + "reason AS reason,",
    prefix + "provider AS provider,",
    prefix + "model AS model,",
    prefix + "created_at AS created_at",
    "FROM context_checkpoints" + (alias ? " " + alias : ""),
  ].join(" ");
}

function checkpointRecord(row: ContextCheckpointRow): ContextCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    streamId: row.stream_id,
    ...(row.previous_checkpoint_id ? { previousCheckpointId: row.previous_checkpoint_id } : {}),
    coveredFromSeq: Number(row.covered_from_seq),
    coveredToSeq: Number(row.covered_to_seq),
    sourceHash: row.source_hash,
    schemaVersion: Number(row.schema_version) as 1,
    summary: JSON.parse(row.summary_json) as ContextCheckpointSummary,
    exactAnchors: JSON.parse(row.exact_anchors_json) as number[],
    tokenCount: Number(row.token_count),
    reason: row.reason,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])
  ).join(",") + "}";
}
