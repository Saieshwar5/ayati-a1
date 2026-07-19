import type { RunOutcome, RunStopReason } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export type UnboundRunFinalizationPhase =
  | "prepared"
  | "files_written"
  | "completed"
  | "recovery_required";

interface Row {
  run_id: string;
  operation_request_id: string;
  session_id: string;
  conversation_id: string;
  phase: UnboundRunFinalizationPhase;
  outcome: RunOutcome;
  stop_reason: RunStopReason;
  materialization_requested: number;
  run_file: string | null;
  steps_file: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface UnboundRunFinalizationRecord {
  runId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  phase: UnboundRunFinalizationPhase;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  materializationRequested: boolean;
  runFile?: string;
  stepsFile?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export function insertUnboundRunFinalization(database: ContextDatabase, input: {
  runId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  materializationRequested: boolean;
  runFile?: string;
  stepsFile?: string;
  at: string;
}): UnboundRunFinalizationRecord {
  database.prepare([
    "INSERT INTO unbound_run_finalizations(",
    "run_id, operation_request_id, session_id, conversation_id, phase, outcome, stop_reason,",
    "materialization_requested,",
    "run_file, steps_file, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, NULL)",
  ].join(" ")).run(
    input.runId,
    input.requestId,
    input.sessionId,
    input.conversationId,
    input.outcome,
    input.stopReason,
    input.materializationRequested ? 1 : 0,
    input.runFile ?? null,
    input.stepsFile ?? null,
    input.at,
    input.at,
  );
  return requireRecord(database, input.runId);
}

export function readUnboundRunFinalization(
  database: ContextDatabase,
  runId: string,
): UnboundRunFinalizationRecord | undefined {
  const row = database.prepare(select() + " WHERE run_id = ?").get(runId) as Row | undefined;
  return row ? record(row) : undefined;
}

export function readRecoverableUnboundRunFinalizations(
  database: ContextDatabase,
): UnboundRunFinalizationRecord[] {
  const rows = database.prepare([
    select(),
    "WHERE phase != 'completed' ORDER BY created_at, run_id",
  ].join(" ")).all() as unknown as Row[];
  return rows.map(record);
}

export function updateUnboundRunFinalization(database: ContextDatabase, input: {
  runId: string;
  phase: UnboundRunFinalizationPhase;
  at: string;
  error?: string;
}): UnboundRunFinalizationRecord {
  database.prepare([
    "UPDATE unbound_run_finalizations SET phase = ?, updated_at = ?, last_error = ?",
    "WHERE run_id = ?",
  ].join(" ")).run(input.phase, input.at, input.error ?? null, input.runId);
  return requireRecord(database, input.runId);
}

function select(): string {
  return [
    "SELECT run_id, operation_request_id, session_id, conversation_id, phase, outcome, stop_reason,",
    "materialization_requested, run_file, steps_file, created_at, updated_at, last_error",
    "FROM unbound_run_finalizations",
  ].join(" ");
}

function requireRecord(
  database: ContextDatabase,
  runId: string,
): UnboundRunFinalizationRecord {
  const value = readUnboundRunFinalization(database, runId);
  if (!value) throw new Error("Unbound run finalization record is missing: " + runId);
  return value;
}

function record(row: Row): UnboundRunFinalizationRecord {
  return {
    runId: row.run_id,
    requestId: row.operation_request_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    phase: row.phase,
    outcome: row.outcome,
    stopReason: row.stop_reason,
    materializationRequested: Number(row.materialization_requested) === 1,
    ...(row.run_file ? { runFile: row.run_file } : {}),
    ...(row.steps_file ? { stepsFile: row.steps_file } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
