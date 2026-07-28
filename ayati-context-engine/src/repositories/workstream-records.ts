import { join } from "node:path";
import type {
  ContextEngineRequestEnvelope,
  WorkstreamCatalogEntry,
  WorkstreamRef,
  WorkstreamStatus,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { buildInitialWorkstreamContext } from "../workstreams/initial-workstream-context.js";
import { workstreamDirectoryName } from "../workstreams/workstream-repository-layout.js";
import { readSharedWorkstreamRepositoryState } from "./workstream-repository-state-records.js";
import { writeWorkstreamRequestProjection } from "./workstream-request-records.js";

interface WorkstreamRow {
  workstream_id: string;
  directory_path: string;
  title: string;
  aliases_json: string;
  purpose: string;
  initial_request_json: string | null;
  lifecycle_status: "active" | "paused" | "archived";
  current_request_id: string | null;
  current_snapshot: string;
  current_focus: string;
  blockers_json: string;
  last_run_id: string | null;
  last_commit_sha: string | null;
  last_activity_at: string;
  status: WorkstreamStatus | "recovery_required";
  created_by_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkstreamInitializationRecord {
  workstreamId: string;
  contextRepositoryPath: string;
  branch: "main";
  head: string;
  lastCommit: string | null;
  materialized: boolean;
  title: string;
  objective: string;
  initialRequest?: {
    title: string;
    request: string;
    acceptance: string[];
    constraints: string[];
  };
  status: WorkstreamStatus | "recovery_required";
  createdByRunId?: string;
  createdAt: string;
  updatedAt: string;
}

interface SimpleWorkstreamAllocationInput extends ContextEngineRequestEnvelope {
  runId: string;
  initialRequest?: WorkstreamInitializationRecord["initialRequest"];
  at: string;
}

export function allocateSimpleWorkstream(
  database: ContextDatabase,
  workstreamRoot: string,
  input: SimpleWorkstreamAllocationInput,
  normalized: { title: string; objective: string },
): WorkstreamInitializationRecord {
  const repository = requireRepositoryState(database);
  const datePart = input.at.slice(0, 10).replaceAll("-", "");
  const prefix = "W-" + datePart + "-";
  const row = database.prepare([
    "SELECT COALESCE(MAX(CAST(substr(workstream_id, 12) AS INTEGER)), 0) + 1 AS next",
    "FROM workstreams WHERE workstream_id LIKE ?",
  ].join(" ")).get(prefix + "%") as { next: number };
  const workstreamId = prefix + String(Number(row.next)).padStart(4, "0");
  const directoryPath = join(
    workstreamRoot,
    workstreamDirectoryName(workstreamId, normalized.title),
  );
  const initial = buildInitialWorkstreamContext({
    workstreamId,
    title: normalized.title,
    purpose: normalized.objective,
    at: input.at,
    ...(input.initialRequest ? { initialRequest: input.initialRequest } : {}),
  });
  database.prepare([
    "INSERT INTO workstreams(",
    "workstream_id, directory_path, title, aliases_json, purpose, initial_request_json,",
    "lifecycle_status, current_request_id, current_snapshot, current_focus, blockers_json,",
    "last_run_id, last_commit_sha, last_activity_at, status, created_by_run_id, created_at, updated_at",
    ") VALUES (?, ?, ?, '[]', ?, ?, 'active', NULL, ?, ?, '[]', NULL, NULL, ?,",
    "'initializing', ?, ?, ?)",
  ].join(" ")).run(
    workstreamId,
    directoryPath,
    normalized.title,
    normalized.objective,
    JSON.stringify(input.initialRequest ?? {
      title: initial.request.title,
      request: initial.request.request,
      acceptance: initial.request.acceptance,
      constraints: initial.request.constraints,
    }),
    initial.card.currentSnapshot,
    initial.card.currentFocus,
    input.at,
    input.runId,
    input.at,
    input.at,
  );
  writeWorkstreamRequestProjection(database, {
    request: initial.request,
    createdByRunId: input.runId,
    lastActivityAt: input.at,
  });
  database.prepare([
    "UPDATE workstreams SET current_request_id = 'R-0001' WHERE workstream_id = ?",
  ].join(" ")).run(workstreamId);
  const workstream = readWorkstreamInitialization(database, workstreamId);
  if (!workstream || workstream.head !== repository.head) {
    throw new Error("Allocated workstream could not be read: " + workstreamId);
  }
  return workstream;
}

export function readWorkstreamInitialization(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamInitializationRecord | undefined {
  const row = readWorkstreamRow(database, workstreamId);
  return row ? initializationRecord(database, row) : undefined;
}

export function readInitializingWorkstreams(
  database: ContextDatabase,
): WorkstreamInitializationRecord[] {
  const rows = database.prepare([
    workstreamSelect(),
    "WHERE status = 'initializing'",
    "ORDER BY created_at, workstream_id",
  ].join(" ")).all() as unknown as WorkstreamRow[];
  return rows.map((row) => initializationRecord(database, row));
}

export function activateWorkstream(
  database: ContextDatabase,
  workstreamId: string,
  commit: string,
  at: string,
): WorkstreamCatalogEntry {
  const result = database.prepare([
    "UPDATE workstreams SET last_commit_sha = ?, status = 'active',",
    "last_activity_at = ?, updated_at = ?",
    "WHERE workstream_id = ? AND status = 'initializing'",
  ].join(" ")).run(commit, at, at, workstreamId);
  if (Number(result.changes) !== 1) {
    throw new Error("Workstream activation did not update exactly one row: " + workstreamId);
  }
  const row = readWorkstreamRow(database, workstreamId);
  if (!row) throw new Error("Activated workstream could not be read: " + workstreamId);
  return catalogEntry(database, row);
}

export function readWorkstreamCatalogEntry(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamCatalogEntry | undefined {
  const row = readWorkstreamRow(database, workstreamId);
  if (!row || !row.last_commit_sha || row.status === "initializing"
    || row.status === "recovery_required") {
    return undefined;
  }
  return catalogEntry(database, row);
}

export function readBindableWorkstreamCatalogEntry(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamCatalogEntry | undefined {
  const row = readWorkstreamRow(database, workstreamId);
  if (!row || row.status === "recovery_required") return undefined;
  return catalogEntry(database, row);
}

export function readWorkstreamCatalogEntries(
  database: ContextDatabase,
  input: { query?: string; limit: number },
): WorkstreamCatalogEntry[] {
  const query = input.query?.trim().toLowerCase();
  const rows = query
    ? database.prepare([
        workstreamSelect(),
        "WHERE status IN ('active', 'archived')",
        "AND (lower(title) LIKE ? OR lower(purpose) LIKE ?)",
        "ORDER BY last_activity_at DESC, workstream_id DESC LIMIT ?",
      ].join(" ")).all("%" + query + "%", "%" + query + "%", input.limit)
    : database.prepare([
        workstreamSelect(),
        "WHERE status IN ('active', 'archived')",
        "ORDER BY last_activity_at DESC, workstream_id DESC LIMIT ?",
      ].join(" ")).all(input.limit);
  return (rows as unknown as WorkstreamRow[]).map((row) => catalogEntry(database, row));
}

export function updateWorkstreamHead(
  database: ContextDatabase,
  workstreamId: string,
  expectedHead: string,
  commit: string,
  at: string,
): WorkstreamCatalogEntry {
  const result = database.prepare([
    "UPDATE workstreams SET last_commit_sha = ?, last_activity_at = ?, updated_at = ?",
    "WHERE workstream_id = ? AND last_commit_sha = ? AND status = 'active'",
  ].join(" ")).run(commit, at, at, workstreamId, expectedHead);
  const workstream = readWorkstreamCatalogEntry(database, workstreamId);
  if (Number(result.changes) !== 1 || !workstream) {
    throw new Error("Workstream revision changed while checkpointing: " + workstreamId);
  }
  return workstream;
}

export function updateWorkstreamProjection(database: ContextDatabase, input: {
  workstreamId: string;
  title: string;
  aliases: string[];
  purpose: string;
  lifecycleStatus: "active" | "paused" | "archived";
  currentRequestId: string | null;
  currentSnapshot: string;
  currentFocus: string;
  blockers: string[];
  lastRunId: string;
  lastCommit: string;
  at: string;
}): void {
  database.prepare([
    "UPDATE workstreams SET title = ?, aliases_json = ?, purpose = ?, lifecycle_status = ?,",
    "current_request_id = ?, current_snapshot = ?, current_focus = ?, blockers_json = ?,",
    "last_run_id = ?, last_commit_sha = ?, last_activity_at = ?, updated_at = ?, status =",
    "CASE WHEN status = 'initializing' THEN 'active' ELSE status END",
    "WHERE workstream_id = ?",
  ].join(" ")).run(
    input.title,
    JSON.stringify(input.aliases),
    input.purpose,
    input.lifecycleStatus,
    input.currentRequestId,
    input.currentSnapshot,
    input.currentFocus,
    JSON.stringify(input.blockers),
    input.lastRunId,
    input.lastCommit,
    input.at,
    input.at,
    input.workstreamId,
  );
}

function readWorkstreamRow(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamRow | undefined {
  return database.prepare(workstreamSelect() + " WHERE workstream_id = ?")
    .get(workstreamId) as WorkstreamRow | undefined;
}

function workstreamSelect(): string {
  return [
    "SELECT workstream_id, directory_path, title, aliases_json, purpose, initial_request_json,",
    "lifecycle_status, current_request_id, current_snapshot, current_focus, blockers_json,",
    "last_run_id, last_commit_sha, last_activity_at, status, created_by_run_id,",
    "created_at, updated_at FROM workstreams",
  ].join(" ");
}

function initializationRecord(
  database: ContextDatabase,
  row: WorkstreamRow,
): WorkstreamInitializationRecord {
  const repository = requireRepositoryState(database);
  return {
    workstreamId: row.workstream_id,
    contextRepositoryPath: row.directory_path,
    branch: "main",
    head: row.last_commit_sha ?? repository.head,
    lastCommit: row.last_commit_sha,
    materialized: Boolean(row.last_commit_sha),
    title: row.title,
    objective: row.purpose,
    ...(row.initial_request_json
      ? {
          initialRequest: JSON.parse(row.initial_request_json) as NonNullable<
            WorkstreamInitializationRecord["initialRequest"]
          >,
        }
      : {}),
    status: row.status,
    ...(row.created_by_run_id ? { createdByRunId: row.created_by_run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function catalogEntry(
  database: ContextDatabase,
  row: WorkstreamRow,
): WorkstreamCatalogEntry {
  const record = initializationRecord(database, row);
  const workstream: WorkstreamRef = {
    workstreamId: row.workstream_id,
    contextRepositoryPath: row.directory_path,
    branch: "main",
    head: record.head,
  };
  return {
    ...workstream,
    title: row.title,
    objective: row.purpose,
    status: row.status === "archived" ? "archived" : row.status === "initializing"
      ? "initializing"
      : "active",
    ...(row.created_by_run_id ? { createdByRunId: row.created_by_run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireRepositoryState(database: ContextDatabase) {
  const state = readSharedWorkstreamRepositoryState(database);
  if (!state) throw new Error("Shared workstream repository is not initialized.");
  return state;
}
