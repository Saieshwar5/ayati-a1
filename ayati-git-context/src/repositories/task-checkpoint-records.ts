import type { ContextDatabase } from "../database/database.js";

export type TaskCheckpointPhase =
  | "prepared"
  | "task_committed"
  | "canonical_persisted"
  | "catalog_updated"
  | "gitlink_updated"
  | "completed"
  | "recovery_required";

interface TaskCheckpointRow {
  authority_id: string;
  request_id: string;
  session_id: string;
  run_id: string;
  task_id: string;
  phase: TaskCheckpointPhase;
  before_head: string;
  checkpoint_head: string | null;
  purpose: string;
  conversation_id: string;
  conversation_hash: string;
  staged_paths_json: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface TaskCheckpointRecord {
  authorityId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  taskId: string;
  phase: TaskCheckpointPhase;
  beforeHead: string;
  checkpointHead?: string;
  purpose: string;
  conversationId: string;
  conversationHash: string;
  stagedPaths: string[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export function insertTaskCheckpoint(database: ContextDatabase, input: {
  authorityId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  taskId: string;
  beforeHead: string;
  purpose: string;
  conversationId: string;
  conversationHash: string;
  stagedPaths: string[];
  at: string;
}): TaskCheckpointRecord {
  database.prepare([
    "INSERT INTO task_checkpoint_transactions(",
    "authority_id, request_id, session_id, run_id, task_id, phase, before_head,",
    "checkpoint_head, purpose, conversation_id, conversation_hash, staged_paths_json,",
    "created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?, ?, ?, ?, ?, NULL)",
  ].join(" ")).run(
    input.authorityId,
    input.requestId,
    input.sessionId,
    input.runId,
    input.taskId,
    input.beforeHead,
    input.purpose,
    input.conversationId,
    input.conversationHash,
    JSON.stringify(input.stagedPaths),
    input.at,
    input.at,
  );
  const record = readTaskCheckpoint(database, input.authorityId);
  if (!record) {
    throw new Error("Inserted task checkpoint could not be read.");
  }
  return record;
}

export function readTaskCheckpoint(
  database: ContextDatabase,
  authorityId: string,
): TaskCheckpointRecord | undefined {
  const row = database.prepare(checkpointSelect() + " WHERE authority_id = ?")
    .get(authorityId) as TaskCheckpointRow | undefined;
  return row ? taskCheckpointRecord(row) : undefined;
}

export function updateTaskCheckpointPhase(database: ContextDatabase, input: {
  authorityId: string;
  phase: TaskCheckpointPhase;
  at: string;
  checkpointHead?: string;
  error?: string;
}): TaskCheckpointRecord {
  database.prepare([
    "UPDATE task_checkpoint_transactions SET phase = ?, updated_at = ?,",
    "checkpoint_head = COALESCE(?, checkpoint_head), last_error = ? WHERE authority_id = ?",
  ].join(" ")).run(
    input.phase,
    input.at,
    input.checkpointHead ?? null,
    input.error ?? null,
    input.authorityId,
  );
  const record = readTaskCheckpoint(database, input.authorityId);
  if (!record) {
    throw new Error("Updated task checkpoint could not be read.");
  }
  return record;
}

function checkpointSelect(): string {
  return [
    "SELECT authority_id, request_id, session_id, run_id, task_id, phase, before_head,",
    "checkpoint_head, purpose, conversation_id, conversation_hash, staged_paths_json,",
    "created_at, updated_at, last_error FROM task_checkpoint_transactions",
  ].join(" ");
}

function taskCheckpointRecord(row: TaskCheckpointRow): TaskCheckpointRecord {
  return {
    authorityId: row.authority_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    runId: row.run_id,
    taskId: row.task_id,
    phase: row.phase,
    beforeHead: row.before_head,
    ...(row.checkpoint_head ? { checkpointHead: row.checkpoint_head } : {}),
    purpose: row.purpose,
    conversationId: row.conversation_id,
    conversationHash: row.conversation_hash,
    stagedPaths: JSON.parse(row.staged_paths_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
