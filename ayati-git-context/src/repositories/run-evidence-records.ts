import type { ContextDatabase } from "../database/database.js";

export type RunEvidenceSnapshotPhase = "prepared" | "files_written" | "staged" | "completed";

interface SnapshotRow {
  request_id: string;
  run_id: string;
  session_id: string;
  task_id: string;
  phase: RunEvidenceSnapshotPhase;
  run_file: string;
  steps_file: string;
  source_revision: string;
  created_at: string;
  updated_at: string;
}

export interface RunEvidenceSnapshotRecord {
  requestId: string;
  runId: string;
  sessionId: string;
  taskId: string;
  phase: RunEvidenceSnapshotPhase;
  runFile: string;
  stepsFile: string;
  sourceRevision: string;
  createdAt: string;
  updatedAt: string;
}

export function insertRunEvidenceSnapshot(database: ContextDatabase, input: {
  requestId: string;
  runId: string;
  sessionId: string;
  taskId: string;
  runFile: string;
  stepsFile: string;
  sourceRevision: string;
  at: string;
}): RunEvidenceSnapshotRecord {
  database.prepare([
    "INSERT INTO run_evidence_snapshots(",
    "request_id, run_id, session_id, task_id, phase, run_file, steps_file,",
    "source_revision, created_at, updated_at",
    ") VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.requestId,
    input.runId,
    input.sessionId,
    input.taskId,
    input.runFile,
    input.stepsFile,
    input.sourceRevision,
    input.at,
    input.at,
  );
  const record = readRunEvidenceSnapshot(database, input.requestId);
  if (!record) {
    throw new Error("Inserted run evidence snapshot could not be read.");
  }
  return record;
}

export function readRunEvidenceSnapshot(
  database: ContextDatabase,
  requestId: string,
): RunEvidenceSnapshotRecord | undefined {
  const row = database.prepare(snapshotSelect() + " WHERE request_id = ?")
    .get(requestId) as SnapshotRow | undefined;
  return row ? snapshotRecord(row) : undefined;
}

export function updateRunEvidenceSnapshotPhase(
  database: ContextDatabase,
  requestId: string,
  phase: RunEvidenceSnapshotPhase,
  at: string,
): RunEvidenceSnapshotRecord {
  database.prepare([
    "UPDATE run_evidence_snapshots SET phase = ?, updated_at = ? WHERE request_id = ?",
  ].join(" ")).run(phase, at, requestId);
  const record = readRunEvidenceSnapshot(database, requestId);
  if (!record) {
    throw new Error("Updated run evidence snapshot could not be read.");
  }
  return record;
}

export function readTaskHeadRange(database: ContextDatabase, runId: string): {
  before: string;
  after: string;
} | undefined {
  const row = database.prepare([
    "SELECT a.before_head, COALESCE(t.head_sha, a.before_head) AS after_head",
    "FROM task_mutation_authorities a JOIN tasks t ON t.task_id = a.task_id",
    "WHERE a.run_id = ? ORDER BY a.acquired_at, a.authority_id LIMIT 1",
  ].join(" ")).get(runId) as { before_head: string | null; after_head: string | null } | undefined;
  return row?.before_head && row.after_head
    ? { before: row.before_head, after: row.after_head }
    : undefined;
}

export function readUncheckpointedMutationStatus(
  database: ContextDatabase,
  runId: string,
): string | undefined {
  const row = database.prepare([
    "SELECT status FROM task_mutation_authorities",
    "WHERE run_id = ? AND status IN ('active', 'verified', 'recovery_required')",
    "ORDER BY acquired_at, authority_id LIMIT 1",
  ].join(" ")).get(runId) as { status: string } | undefined;
  return row?.status;
}

function snapshotSelect(): string {
  return [
    "SELECT request_id, run_id, session_id, task_id, phase, run_file, steps_file,",
    "source_revision, created_at, updated_at FROM run_evidence_snapshots",
  ].join(" ");
}

function snapshotRecord(row: SnapshotRow): RunEvidenceSnapshotRecord {
  return {
    requestId: row.request_id,
    runId: row.run_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    phase: row.phase,
    runFile: row.run_file,
    stepsFile: row.steps_file,
    sourceRevision: row.source_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
