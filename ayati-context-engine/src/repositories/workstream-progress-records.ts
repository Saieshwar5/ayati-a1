import type { RunOutcome } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import type { WorkstreamProgressEntry } from "../workstreams/workstream-progress.js";

export interface WorkstreamProgressProjection {
  runId: string;
  workstreamId: string;
  requestId: string;
  outcome: RunOutcome;
  summary: string;
  validationSummary: string;
  nextAction?: string;
  commit: string;
  finalizedAt: string;
}

interface Row {
  run_id: string;
  workstream_id: string;
  request_id: string;
  outcome: RunOutcome;
  summary: string;
  validation_summary: string;
  next_action: string | null;
  commit_sha: string;
  finalized_at: string;
}

export function insertWorkstreamProgressProjection(
  database: ContextDatabase,
  input: {
    workstreamId: string;
    entry: WorkstreamProgressEntry;
    commit: string;
  },
): void {
  database.prepare([
    "INSERT INTO workstream_progress(",
    "run_id, workstream_id, request_id, outcome, summary, validation_summary,",
    "next_action, commit_sha, finalized_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(run_id) DO NOTHING",
  ].join(" ")).run(
    input.entry.runId,
    input.workstreamId,
    input.entry.requestId,
    input.entry.outcome,
    input.entry.summary,
    input.entry.validation.join(" "),
    input.entry.next ?? null,
    input.commit,
    input.entry.at,
  );
  const stored = readWorkstreamProgressProjection(database, input.entry.runId);
  const validationSummary = input.entry.validation.join(" ");
  if (!stored
    || stored.workstreamId !== input.workstreamId
    || stored.requestId !== input.entry.requestId
    || stored.commit !== input.commit
    || stored.outcome !== input.entry.outcome
    || stored.summary !== input.entry.summary
    || stored.validationSummary !== validationSummary
    || (stored.nextAction ?? null) !== (input.entry.next ?? null)
    || stored.finalizedAt !== input.entry.at) {
    throw new Error("Workstream progress projection conflicts with its finalized run.");
  }
}

export function readWorkstreamProgressProjection(
  database: ContextDatabase,
  runId: string,
): WorkstreamProgressProjection | undefined {
  const row = database.prepare(select() + " WHERE run_id = ?").get(runId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function readRecentRequestProgress(
  database: ContextDatabase,
  input: {
    workstreamId: string;
    requestId: string;
    limit: number;
  },
): WorkstreamProgressProjection[] {
  const rows = database.prepare([
    select(),
    "WHERE workstream_id = ? AND request_id = ?",
    "ORDER BY finalized_at DESC, run_id DESC LIMIT ?",
  ].join(" ")).all(
    input.workstreamId,
    input.requestId,
    input.limit,
  ) as unknown as Row[];
  return rows.map(fromRow);
}

function select(): string {
  return [
    "SELECT run_id, workstream_id, request_id, outcome, summary, validation_summary,",
    "next_action, commit_sha, finalized_at FROM workstream_progress",
  ].join(" ");
}

function fromRow(row: Row): WorkstreamProgressProjection {
  return {
    runId: row.run_id,
    workstreamId: row.workstream_id,
    requestId: row.request_id,
    outcome: row.outcome,
    summary: row.summary,
    validationSummary: row.validation_summary,
    ...(row.next_action ? { nextAction: row.next_action } : {}),
    commit: row.commit_sha,
    finalizedAt: row.finalized_at,
  };
}
