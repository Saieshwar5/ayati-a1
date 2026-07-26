import type {
  RunImportantContextItem,
  RunWorkPlanItem,
  RunWorkState,
  RunWorkStateInput,
  RunWorkStateUpdateReason,
} from "../run-work-state-contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface RunWorkStateRow {
  run_id: string;
  revision: number;
  after_step: number;
  status: RunWorkState["status"];
  summary: string;
  plan_json: string;
  important_context_json: string;
  next_action: string | null;
  update_reason: RunWorkStateUpdateReason;
  updated_at: string;
}

export function insertInitialRunWorkState(
  database: ContextDatabase,
  runId: string,
  state: RunWorkStateInput,
  at: string,
): RunWorkState {
  database.prepare([
    "INSERT INTO run_work_state(",
    "run_id, revision, after_step, status, summary, plan_json, important_context_json,",
    "next_action, update_reason, updated_at",
    ") VALUES (?, 0, 0, ?, ?, ?, ?, ?, 'initial', ?)",
  ].join(" ")).run(
    runId,
    state.status,
    state.summary,
    JSON.stringify(state.plan),
    JSON.stringify(state.importantContext),
    state.nextAction,
    at,
  );
  return requireRunWorkState(database, runId);
}

export function replaceRunWorkState(
  database: ContextDatabase,
  input: {
    runId: string;
    afterStep: number;
    state: RunWorkStateInput;
    reason: RunWorkStateUpdateReason;
    at: string;
    expectedRevision?: number;
  },
): RunWorkState {
  const revisionClause = input.expectedRevision === undefined
    ? ""
    : " AND revision = ?";
  const values: Array<string | number | null> = [
    input.afterStep,
    input.state.status,
    input.state.summary,
    JSON.stringify(input.state.plan),
    JSON.stringify(input.state.importantContext),
    input.state.nextAction,
    input.reason,
    input.at,
    input.runId,
  ];
  if (input.expectedRevision !== undefined) {
    values.push(input.expectedRevision);
  }
  const result = database.prepare([
    "UPDATE run_work_state SET revision = revision + 1, after_step = ?, status = ?,",
    "summary = ?, plan_json = ?, important_context_json = ?, next_action = ?,",
    "update_reason = ?, updated_at = ? WHERE run_id = ?" + revisionClause,
  ].join(" ")).run(...values);
  if (Number(result.changes) !== 1) {
    throw new Error(
      input.expectedRevision === undefined
        ? "Run WorkState could not be updated: " + input.runId
        : `Run WorkState revision conflict: ${input.runId} expected ${input.expectedRevision}`,
    );
  }
  return requireRunWorkState(database, input.runId);
}

export function readRunWorkState(
  database: ContextDatabase,
  runId: string,
): RunWorkState | undefined {
  const row = database.prepare([
    "SELECT run_id, revision, after_step, status, summary, plan_json,",
    "important_context_json, next_action, update_reason, updated_at",
    "FROM run_work_state WHERE run_id = ?",
  ].join(" ")).get(runId) as RunWorkStateRow | undefined;
  return row ? runWorkState(row) : undefined;
}

export function readLatestContinuationWorkState(
  database: ContextDatabase,
  input: {
    excludeRunId: string;
    workstreamId: string;
    boundRequestId: string;
  },
): RunWorkState | undefined {
  const row = database.prepare([
    "SELECT ws.run_id, ws.revision, ws.after_step, ws.status, ws.summary,",
    "ws.plan_json, ws.important_context_json, ws.next_action,",
    "ws.update_reason, ws.updated_at",
    "FROM run_work_state ws",
    "JOIN runs r ON r.run_id = ws.run_id",
    "WHERE r.run_id <> ? AND r.workstream_id = ? AND r.bound_request_id = ?",
    "AND r.status NOT IN ('running', 'recovery_required')",
    "ORDER BY r.completed_at DESC, r.run_sequence DESC LIMIT 1",
  ].join(" ")).get(
    input.excludeRunId,
    input.workstreamId,
    input.boundRequestId,
  ) as RunWorkStateRow | undefined;
  return row ? runWorkState(row) : undefined;
}

function requireRunWorkState(database: ContextDatabase, runId: string): RunWorkState {
  const state = readRunWorkState(database, runId);
  if (!state) {
    throw new Error("Run WorkState is missing: " + runId);
  }
  return state;
}

function runWorkState(row: RunWorkStateRow): RunWorkState {
  return {
    runId: row.run_id,
    revision: Number(row.revision),
    afterStep: Number(row.after_step),
    status: row.status,
    summary: row.summary,
    plan: parseJsonArray<RunWorkPlanItem>(row.plan_json),
    importantContext: parseJsonArray<RunImportantContextItem>(row.important_context_json),
    nextAction: row.next_action,
    updateReason: row.update_reason,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}
