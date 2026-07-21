import type {
  RunWorkState,
  RunWorkStateInput,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface RunWorkStateRow {
  run_id: string;
  revision: number;
  after_step: number;
  status: RunWorkState["status"];
  summary: string;
  open_work_json: string;
  blockers_json: string;
  facts_json: string;
  evidence_json: string;
  artifacts_json: string;
  next_step: string | null;
  user_input_needed_json: string;
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
    "run_id, revision, after_step, status, summary, open_work_json, blockers_json,",
    "facts_json, evidence_json, artifacts_json, next_step, user_input_needed_json, updated_at",
    ") VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(...workStateValues(runId, state, at));
  return requireRunWorkState(database, runId);
}

export function replaceRunWorkState(
  database: ContextDatabase,
  input: {
    runId: string;
    afterStep: number;
    state: RunWorkStateInput;
    at: string;
  },
): RunWorkState {
  const result = database.prepare([
    "UPDATE run_work_state SET revision = revision + 1, after_step = ?, status = ?,",
    "summary = ?, open_work_json = ?, blockers_json = ?, facts_json = ?, evidence_json = ?,",
    "artifacts_json = ?, next_step = ?, user_input_needed_json = ?, updated_at = ?",
    "WHERE run_id = ?",
  ].join(" ")).run(
    input.afterStep,
    input.state.status,
    input.state.summary,
    JSON.stringify(input.state.openWork),
    JSON.stringify(input.state.blockers),
    JSON.stringify(input.state.facts),
    JSON.stringify(input.state.evidence),
    JSON.stringify(input.state.artifacts),
    input.state.nextStep,
    JSON.stringify(input.state.userInputNeeded),
    input.at,
    input.runId,
  );
  if (Number(result.changes) !== 1) {
    throw new Error("Run WorkState could not be updated: " + input.runId);
  }
  return requireRunWorkState(database, input.runId);
}

export function readRunWorkState(
  database: ContextDatabase,
  runId: string,
): RunWorkState | undefined {
  const row = database.prepare([
    "SELECT run_id, revision, after_step, status, summary, open_work_json, blockers_json,",
    "facts_json, evidence_json, artifacts_json, next_step, user_input_needed_json, updated_at",
    "FROM run_work_state WHERE run_id = ?",
  ].join(" ")).get(runId) as RunWorkStateRow | undefined;
  return row ? runWorkState(row) : undefined;
}

function requireRunWorkState(database: ContextDatabase, runId: string): RunWorkState {
  const state = readRunWorkState(database, runId);
  if (!state) {
    throw new Error("Run WorkState is missing: " + runId);
  }
  return state;
}

function workStateValues(
  runId: string,
  state: RunWorkStateInput,
  at: string,
): [string, string, string, string, string, string, string, string, string | null, string, string] {
  return [
    runId,
    state.status,
    state.summary,
    JSON.stringify(state.openWork),
    JSON.stringify(state.blockers),
    JSON.stringify(state.facts),
    JSON.stringify(state.evidence),
    JSON.stringify(state.artifacts),
    state.nextStep,
    JSON.stringify(state.userInputNeeded),
    at,
  ];
}

function runWorkState(row: RunWorkStateRow): RunWorkState {
  return {
    runId: row.run_id,
    revision: Number(row.revision),
    afterStep: Number(row.after_step),
    status: row.status,
    summary: row.summary,
    openWork: parseStringArray(row.open_work_json),
    blockers: parseStringArray(row.blockers_json),
    facts: parseStringArray(row.facts_json),
    evidence: parseStringArray(row.evidence_json),
    artifacts: parseStringArray(row.artifacts_json),
    nextStep: row.next_step,
    userInputNeeded: parseStringArray(row.user_input_needed_json),
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string): string[] {
  return JSON.parse(value) as string[];
}
