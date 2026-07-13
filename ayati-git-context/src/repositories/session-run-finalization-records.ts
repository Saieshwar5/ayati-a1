import type { ContextDatabase } from "../database/database.js";

export type SessionRunFinalizationPhase = "prepared" | "files_written" | "completed";

interface SessionRunFinalizationRow {
  run_id: string;
  request_id: string;
  session_id: string;
  conversation_id: string;
  phase: SessionRunFinalizationPhase;
  run_file: string;
  steps_file: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRunFinalizationRecord {
  runId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  phase: SessionRunFinalizationPhase;
  runFile: string;
  stepsFile: string;
  createdAt: string;
  updatedAt: string;
}

export function insertSessionRunFinalization(database: ContextDatabase, input: {
  runId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  runFile: string;
  stepsFile: string;
  at: string;
}): SessionRunFinalizationRecord {
  database.prepare([
    "INSERT INTO session_run_finalizations(",
    "run_id, request_id, session_id, conversation_id, phase, run_file, steps_file,",
    "created_at, updated_at",
    ") VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?)",
  ].join(" ")).run(
    input.runId, input.requestId, input.sessionId, input.conversationId,
    input.runFile, input.stepsFile, input.at, input.at,
  );
  return requireSessionRunFinalization(database, input.runId);
}

export function readSessionRunFinalization(
  database: ContextDatabase,
  runId: string,
): SessionRunFinalizationRecord | undefined {
  const row = database.prepare([
    "SELECT run_id, request_id, session_id, conversation_id, phase, run_file, steps_file,",
    "created_at, updated_at FROM session_run_finalizations WHERE run_id = ?",
  ].join(" ")).get(runId) as SessionRunFinalizationRow | undefined;
  return row ? record(row) : undefined;
}

export function updateSessionRunFinalization(
  database: ContextDatabase,
  runId: string,
  phase: SessionRunFinalizationPhase,
  at: string,
): SessionRunFinalizationRecord {
  database.prepare([
    "UPDATE session_run_finalizations SET phase = ?, updated_at = ? WHERE run_id = ?",
  ].join(" ")).run(phase, at, runId);
  return requireSessionRunFinalization(database, runId);
}

function requireSessionRunFinalization(
  database: ContextDatabase,
  runId: string,
): SessionRunFinalizationRecord {
  const value = readSessionRunFinalization(database, runId);
  if (!value) throw new Error("Session-run finalization is missing: " + runId);
  return value;
}

function record(row: SessionRunFinalizationRow): SessionRunFinalizationRecord {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    phase: row.phase,
    runFile: row.run_file,
    stepsFile: row.steps_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
