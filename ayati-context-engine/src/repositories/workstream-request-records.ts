import { createHash } from "node:crypto";
import type { ContextDatabase } from "../database/database.js";
import {
  type WorkstreamRequest,
  type WorkstreamRequestStatus,
} from "../workstreams/workstream-request.js";

interface Row {
  workstream_id: string;
  request_id: string;
  relative_path: string;
  title: string;
  status: WorkstreamRequestStatus;
  source: WorkstreamRequest["source"];
  request_text: string;
  acceptance_json: string;
  constraints_json: string;
  lifecycle_note: string;
  outcome_summary: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  closed_at: string | null;
}

export interface WorkstreamRequestSearchHit {
  workstreamId: string;
  requestId: string;
  title: string;
  status: WorkstreamRequestStatus;
}

export function writeWorkstreamRequestProjection(
  database: ContextDatabase,
  input: {
    request: WorkstreamRequest;
    createdByRunId?: string;
    lastRunId?: string;
    lastActivityAt: string;
  },
): void {
  const request = input.request;
  const contractHash = hashContract(request);
  database.prepare([
    "INSERT INTO workstream_requests(",
    "workstream_id, request_id, relative_path, title, status, source, request_text,",
    "acceptance_json, constraints_json, contract_hash, lifecycle_note, outcome_summary,",
    "created_by_run_id, last_run_id, created_at, updated_at, started_at, closed_at, last_activity_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(workstream_id, request_id) DO UPDATE SET",
    "relative_path = excluded.relative_path, title = excluded.title, status = excluded.status,",
    "source = excluded.source, request_text = excluded.request_text,",
    "acceptance_json = excluded.acceptance_json, constraints_json = excluded.constraints_json,",
    "contract_hash = excluded.contract_hash, lifecycle_note = excluded.lifecycle_note,",
    "outcome_summary = excluded.outcome_summary,",
    "last_run_id = COALESCE(excluded.last_run_id, workstream_requests.last_run_id),",
    "updated_at = excluded.updated_at, started_at = excluded.started_at,",
    "closed_at = excluded.closed_at, last_activity_at = excluded.last_activity_at",
  ].join(" ")).run(
    request.workstreamId,
    request.id,
    request.relativePath,
    request.title,
    request.status,
    request.source,
    request.request,
    JSON.stringify(request.acceptance),
    JSON.stringify(request.constraints),
    contractHash,
    request.lifecycleNote,
    request.finalOutcome,
    input.createdByRunId ?? null,
    input.lastRunId ?? null,
    request.createdAt,
    request.updatedAt,
    request.startedAt,
    request.closedAt,
    input.lastActivityAt,
  );
  writeRequestSearch(database, request);
}

export function readWorkstreamRequests(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamRequest[] {
  return (database.prepare(select() + " WHERE workstream_id = ? ORDER BY request_id")
    .all(workstreamId) as unknown as Row[]).map(fromRow);
}

export function readWorkstreamRequest(
  database: ContextDatabase,
  workstreamId: string,
  requestId: string,
): WorkstreamRequest | undefined {
  const row = database.prepare(select() + " WHERE workstream_id = ? AND request_id = ?")
    .get(workstreamId, requestId) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export function readUnfinishedWorkstreamRequests(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamRequest[] {
  return (database.prepare([
    select(),
    "WHERE workstream_id = ? AND status IN ('queued', 'active', 'blocked')",
    "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, request_id",
  ].join(" ")).all(workstreamId) as unknown as Row[]).map(fromRow);
}

export function searchWorkstreamRequests(
  database: ContextDatabase,
  matchExpression: string,
  limit: number,
): WorkstreamRequestSearchHit[] {
  if (!matchExpression) return [];
  const rows = database.prepare([
    "SELECT workstream_request_search.workstream_id,",
    "workstream_request_search.request_id, q.title, q.status",
    "FROM workstream_request_search",
    "JOIN workstream_requests q",
    "ON q.workstream_id = workstream_request_search.workstream_id",
    "AND q.request_id = workstream_request_search.request_id",
    "WHERE workstream_request_search MATCH ?",
    "ORDER BY bm25(workstream_request_search),",
    "workstream_request_search.workstream_id, workstream_request_search.request_id",
    "LIMIT ?",
  ].join(" ")).all(matchExpression, limit) as unknown as Array<{
    workstream_id: string;
    request_id: string;
    title: string;
    status: WorkstreamRequestStatus;
  }>;
  return rows.map((row) => ({
    workstreamId: row.workstream_id,
    requestId: row.request_id,
    title: row.title,
    status: row.status,
  }));
}

export function synchronizeCurrentWorkstreamRequest(
  database: ContextDatabase,
  workstreamId: string,
): void {
  const active = database.prepare([
    "SELECT request_id FROM workstream_requests",
    "WHERE workstream_id = ? AND status = 'active'",
  ].join(" ")).all(workstreamId) as unknown as Array<{ request_id: string }>;
  if (active.length > 1) {
    throw new Error("A workstream has more than one active request: " + workstreamId);
  }
  database.prepare(
    "UPDATE workstreams SET current_request_id = ? WHERE workstream_id = ?",
  ).run(active[0]?.request_id ?? null, workstreamId);
}

function writeRequestSearch(database: ContextDatabase, request: WorkstreamRequest): void {
  database.prepare([
    "DELETE FROM workstream_request_search WHERE workstream_id = ? AND request_id = ?",
  ].join(" ")).run(request.workstreamId, request.id);
  database.prepare([
    "INSERT INTO workstream_request_search(",
    "workstream_id, request_id, status, title, request_text, acceptance, constraints,",
    "lifecycle_note, outcome_summary",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    request.workstreamId,
    request.id,
    request.status,
    request.title,
    request.request,
    request.acceptance.join("\n"),
    request.constraints.join("\n"),
    request.lifecycleNote,
    request.finalOutcome,
  );
}

function hashContract(request: WorkstreamRequest): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify({
      title: request.title,
      request: request.request,
      acceptance: request.acceptance,
      constraints: request.constraints,
    }))
    .digest("hex");
}

function select(): string {
  return [
    "SELECT workstream_id, request_id, relative_path, title, status, source, request_text,",
    "acceptance_json, constraints_json, lifecycle_note, outcome_summary,",
    "created_at, updated_at, started_at, closed_at FROM workstream_requests",
  ].join(" ");
}

function fromRow(row: Row): WorkstreamRequest {
  return {
    schema: "ayati.request/v3",
    id: row.request_id,
    workstreamId: row.workstream_id,
    relativePath: row.relative_path,
    title: row.title,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    request: row.request_text,
    acceptance: JSON.parse(row.acceptance_json) as string[],
    constraints: JSON.parse(row.constraints_json) as string[],
    lifecycleNote: row.lifecycle_note,
    finalOutcome: row.outcome_summary,
  };
}
