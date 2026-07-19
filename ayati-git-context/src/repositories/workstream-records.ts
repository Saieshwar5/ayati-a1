import { join } from "node:path";
import type {
  GitContextRequestEnvelope,
  SessionId,
  WorkstreamCatalogEntry,
  WorkstreamRef,
  WorkstreamStatus,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { workstreamDirectoryName } from "../workstreams/workstream-repository-layout.js";

interface WorkstreamRow {
  workstream_id: string;
  repository_path: string;
  branch: string;
  head_sha: string | null;
  title_cache: string;
  objective_cache: string;
  lifecycle_status: "active" | "paused" | "archived";
  repository_health: "ready" | "dirty_external" | "unavailable";
  current_request_id: string | null;
  current_request_title: string | null;
  current_request_status: "queued" | "active" | "blocked" | "done" | "dropped" | null;
  status: WorkstreamStatus | "recovery_required";
  created_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkstreamInitializationRecord {
  workstreamId: string;
  contextRepositoryPath: string;
  branch: "main";
  head: string | null;
  title: string;
  objective: string;
  status: WorkstreamStatus | "recovery_required";
  createdSessionId: string;
  createdAt: string;
  updatedAt: string;
}

interface SimpleWorkstreamAllocationInput extends GitContextRequestEnvelope {
  sessionId: SessionId;
  at: string;
}

export function allocateSimpleWorkstream(
  database: ContextDatabase,
  workstreamRoot: string,
  input: SimpleWorkstreamAllocationInput,
  normalized: { title: string; objective: string },
): WorkstreamInitializationRecord {
  const datePart = input.sessionId.match(/^S-(\d{8})-/)?.[1]
    ?? input.at.slice(0, 10).replaceAll("-", "");
  const prefix = "W-" + datePart + "-";
  const row = database.prepare([
    "SELECT COALESCE(MAX(CAST(substr(workstream_id, 12) AS INTEGER)), 0) + 1 AS next",
    "FROM workstreams WHERE workstream_id LIKE ?",
  ].join(" ")).get(prefix + "%") as { next: number };
  const workstreamId = prefix + String(Number(row.next)).padStart(4, "0");
  const contextRepositoryPath = join(
    workstreamRoot,
    workstreamDirectoryName(workstreamId, normalized.title),
  );
  database.prepare([
    "INSERT INTO workstreams(",
    "workstream_id, repository_path, branch, head_sha, title_cache, objective_cache,",
    "lifecycle_status, repository_health, current_request_id, current_request_title,",
    "current_request_status, status, created_session_id, created_at, updated_at",
    ") VALUES (?, ?, 'main', NULL, ?, ?, 'active', 'ready', 'R-0001', ?,",
    "'active', 'initializing', ?, ?, ?)",
  ].join(" ")).run(
    workstreamId,
    contextRepositoryPath,
    normalized.title,
    normalized.objective,
    normalized.title,
    input.sessionId,
    input.at,
    input.at,
  );
  const workstream = readWorkstreamInitialization(database, workstreamId);
  if (!workstream) {
    throw new Error("Allocated workstream could not be read: " + workstreamId);
  }
  return workstream;
}

export function readWorkstreamInitialization(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamInitializationRecord | undefined {
  const row = readWorkstreamRow(database, workstreamId);
  return row ? initializationRecord(row) : undefined;
}

export function readInitializingWorkstreams(
  database: ContextDatabase,
): WorkstreamInitializationRecord[] {
  const rows = database.prepare([
    workstreamSelect(),
    "WHERE status = 'initializing'",
    "ORDER BY created_at, workstream_id",
  ].join(" ")).all() as unknown as WorkstreamRow[];
  return rows.map(initializationRecord);
}

export function activateWorkstream(
  database: ContextDatabase,
  workstreamId: string,
  head: string,
  at: string,
): WorkstreamCatalogEntry {
  const result = database.prepare([
    "UPDATE workstreams SET head_sha = ?, status = 'active', repository_health = 'ready', updated_at = ?",
    "WHERE workstream_id = ? AND status = 'initializing'",
  ].join(" ")).run(head, at, workstreamId);
  if (Number(result.changes) !== 1) {
    throw new Error("Workstream activation did not update exactly one row: " + workstreamId);
  }
  const row = readWorkstreamRow(database, workstreamId);
  if (!row) {
    throw new Error("Activated workstream could not be read: " + workstreamId);
  }
  return catalogEntry(row);
}

export function readWorkstreamCatalogEntry(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamCatalogEntry | undefined {
  const row = readWorkstreamRow(database, workstreamId);
  if (!row || !row.head_sha || row.status === "recovery_required") {
    return undefined;
  }
  return catalogEntry(row);
}

export function readWorkstreamCatalogEntries(
  database: ContextDatabase,
  input: { query?: string; limit: number },
): WorkstreamCatalogEntry[] {
  const query = input.query?.trim().toLowerCase();
  const rows = query
    ? database.prepare([
        workstreamSelect(),
        "WHERE status = 'active'",
        "AND (lower(title_cache) LIKE ? OR lower(objective_cache) LIKE ?)",
        "ORDER BY updated_at DESC, workstream_id DESC LIMIT ?",
      ].join(" ")).all("%" + query + "%", "%" + query + "%", input.limit)
    : database.prepare([
        workstreamSelect(),
        "WHERE status = 'active'",
        "ORDER BY updated_at DESC, workstream_id DESC LIMIT ?",
      ].join(" ")).all(input.limit);
  return (rows as unknown as WorkstreamRow[])
    .filter((row) => Boolean(row.head_sha))
    .map(catalogEntry);
}

export function updateWorkstreamHead(
  database: ContextDatabase,
  workstreamId: string,
  expectedHead: string,
  head: string,
  at: string,
): WorkstreamCatalogEntry {
  const result = database.prepare([
    "UPDATE workstreams SET head_sha = ?, repository_health = 'ready', updated_at = ?",
    "WHERE workstream_id = ? AND head_sha = ? AND status = 'active'",
  ].join(" ")).run(head, at, workstreamId, expectedHead);
  const workstream = readWorkstreamCatalogEntry(database, workstreamId);
  if (Number(result.changes) !== 1 || !workstream) {
    throw new Error("Workstream HEAD changed while checkpointing: " + workstreamId);
  }
  return workstream;
}

function readWorkstreamRow(database: ContextDatabase, workstreamId: string): WorkstreamRow | undefined {
  return database.prepare([
    workstreamSelect(),
    "WHERE workstream_id = ?",
  ].join(" ")).get(workstreamId) as WorkstreamRow | undefined;
}

function workstreamSelect(): string {
  return [
    "SELECT workstream_id, repository_path, branch, head_sha, title_cache, objective_cache,",
    "lifecycle_status, repository_health, current_request_id, current_request_title,",
    "current_request_status, status, created_session_id, created_at, updated_at FROM workstreams",
  ].join(" ");
}

function initializationRecord(row: WorkstreamRow): WorkstreamInitializationRecord {
  return {
    workstreamId: row.workstream_id,
    contextRepositoryPath: row.repository_path,
    branch: "main",
    head: row.head_sha,
    title: row.title_cache,
    objective: row.objective_cache,
    status: row.status,
    createdSessionId: row.created_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function catalogEntry(row: WorkstreamRow): WorkstreamCatalogEntry {
  if (!row.head_sha) {
    throw new Error("Active workstream is missing its Git HEAD: " + row.workstream_id);
  }
  const workstream: WorkstreamRef = {
    workstreamId: row.workstream_id,
    contextRepositoryPath: row.repository_path,
    branch: row.branch,
    head: row.head_sha,
  };
  return {
    ...workstream,
    title: row.title_cache,
    objective: row.objective_cache,
    status: row.status === "archived" ? "archived" : "active",
    createdSessionId: row.created_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
