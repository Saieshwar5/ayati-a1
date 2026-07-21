import type {
  SetWorkstreamStarResponse,
  WorkstreamCatalogEntry,
  WorkstreamContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export interface WorkstreamDiscoveryRow {
  workstreamId: string;
  branch: string;
  head: string;
  title: string;
  objective: string;
  status: "active" | "archived";
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external" | "unavailable";
  currentRequestId?: string;
  currentRequestTitle?: string;
  currentRequestStatus?: "queued" | "active" | "blocked" | "done" | "dropped";
  updatedAt: string;
  starred: boolean;
  starredAt?: string;
  lastOpenedAt?: string;
  boundRunsLast30Days: number;
  boundRunsLifetime: number;
}

export interface WorkstreamDiscoveryProjectionWrite {
  workstreamId: string;
  expectedHead: string;
  title: string;
  objective: string;
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external" | "unavailable";
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
    searchText: string;
  };
}

interface WorkstreamDiscoveryDatabaseRow {
  workstream_id: string;
  branch: string;
  head_sha: string;
  title_cache: string;
  objective_cache: string;
  status: "active" | "archived";
  lifecycle_status: "active" | "paused" | "archived";
  repository_health: "ready" | "dirty_external" | "unavailable";
  current_request_id: string | null;
  current_request_title: string | null;
  current_request_status: "queued" | "active" | "blocked" | "done" | "dropped" | null;
  updated_at: string;
  starred: number;
  starred_at: string | null;
  last_opened_at: string | null;
  bound_runs_30d: number;
  bound_runs_lifetime: number;
}

export function readWorkstreamDiscoveryRows(
  database: ContextDatabase,
  cutoff: string,
): WorkstreamDiscoveryRow[] {
  const rows = database.prepare([
    "SELECT t.workstream_id, t.branch, t.head_sha,",
    "t.title_cache, t.objective_cache, t.status, t.lifecycle_status,",
    "t.repository_health, t.current_request_id, t.current_request_title,",
    "t.current_request_status, t.updated_at,",
    "COALESCE(p.starred, 0) AS starred, p.starred_at,",
    "MAX(a.accessed_at) AS last_opened_at,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' AND a.accessed_at >= ?",
    "  THEN a.run_id END) AS bound_runs_30d,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' THEN a.run_id END)",
    "  AS bound_runs_lifetime",
    "FROM workstreams t",
    "LEFT JOIN workstream_preferences p ON p.workstream_id = t.workstream_id",
    "LEFT JOIN workstream_accesses a ON a.workstream_id = t.workstream_id",
    "WHERE t.status != 'initializing' AND t.head_sha IS NOT NULL",
    "GROUP BY t.workstream_id",
    "ORDER BY t.updated_at DESC, t.workstream_id DESC",
  ].join(" ")).all(cutoff) as unknown as WorkstreamDiscoveryDatabaseRow[];
  return rows.map((row) => ({
    workstreamId: row.workstream_id,
    branch: row.branch,
    head: row.head_sha,
    title: row.title_cache,
    objective: row.objective_cache,
    status: row.status,
    lifecycleStatus: row.lifecycle_status,
    repositoryHealth: row.repository_health,
    ...(row.current_request_id && row.current_request_title && row.current_request_status
      ? {
          currentRequestId: row.current_request_id,
          currentRequestTitle: row.current_request_title,
          currentRequestStatus: row.current_request_status,
        }
      : {}),
    updatedAt: row.updated_at,
    starred: row.starred === 1,
    ...(row.starred_at ? { starredAt: row.starred_at } : {}),
    ...(row.last_opened_at ? { lastOpenedAt: row.last_opened_at } : {}),
    boundRunsLast30Days: Number(row.bound_runs_30d),
    boundRunsLifetime: Number(row.bound_runs_lifetime),
  }));
}

export function searchWorkstreamIds(
  database: ContextDatabase,
  matchExpression: string,
  limit: number,
): string[] {
  if (!matchExpression) return [];
  const rows = database.prepare([
    "SELECT workstream_id FROM workstream_search",
    "WHERE workstream_search MATCH ?",
    "ORDER BY bm25(workstream_search), workstream_id",
    "LIMIT ?",
  ].join(" ")).all(matchExpression, limit) as unknown as Array<{ workstream_id: string }>;
  return rows.map((row) => row.workstream_id);
}

export function refreshWorkstreamDiscoveryProjection(input: {
  database: ContextDatabase;
  workstream: WorkstreamCatalogEntry;
  context: WorkstreamContextProjection;
}): void {
  if (input.context.workstream.head !== input.workstream.head
    || input.context.workstream.branch !== input.workstream.branch) {
    return;
  }
  const current = input.context.currentRequest;
  const existing = input.database.prepare([
    "SELECT title_cache, objective_cache, lifecycle_status, repository_health,",
    "current_request_id, current_request_title, current_request_status",
    "FROM workstreams WHERE workstream_id = ?",
  ].join(" ")).get(input.workstream.workstreamId) as {
    title_cache: string;
    objective_cache: string;
    lifecycle_status: string;
    repository_health: string;
    current_request_id: string | null;
    current_request_title: string | null;
    current_request_status: string | null;
  } | undefined;
  if (!existing) return;
  const projectionChanged = existing.title_cache !== input.context.title
    || existing.objective_cache !== input.context.objective
    || existing.lifecycle_status !== (input.context.lifecycleStatus ?? "active")
    || existing.repository_health !== (input.context.repositoryHealth ?? "ready")
    || existing.current_request_id !== (current?.id ?? null)
    || existing.current_request_title !== (current?.title ?? null)
    || existing.current_request_status !== (current?.status ?? null);
  const searchExists = input.database.prepare(
    "SELECT 1 AS found FROM workstream_search WHERE workstream_id = ? LIMIT 1",
  ).get(input.workstream.workstreamId) as { found: number } | undefined;
  if (!projectionChanged && searchExists) return;
  input.database.transaction(() => {
    writeWorkstreamDiscoveryProjection(input.database, {
      workstreamId: input.workstream.workstreamId,
      expectedHead: input.workstream.head,
      title: input.context.title,
      objective: input.context.objective,
      lifecycleStatus: input.context.lifecycleStatus ?? "active",
      repositoryHealth: input.context.repositoryHealth ?? "ready",
      ...(current ? {
          currentRequest: {
            id: current.id,
            title: current.title,
            status: current.status,
            searchText: [current.title, current.request].join("\n"),
          },
        } : {}),
    });
  });
}

export function writeWorkstreamDiscoveryProjection(
  database: ContextDatabase,
  input: WorkstreamDiscoveryProjectionWrite,
): void {
  const current = input.currentRequest;
  const updated = database.prepare([
    "UPDATE workstreams SET title_cache = ?, objective_cache = ?, lifecycle_status = ?,",
    "repository_health = ?, current_request_id = ?, current_request_title = ?,",
    "current_request_status = ? WHERE workstream_id = ? AND head_sha = ?",
  ].join(" ")).run(
    input.title,
    input.objective,
    input.lifecycleStatus,
    input.repositoryHealth,
    current?.id ?? null,
    current?.title ?? null,
    current?.status ?? null,
    input.workstreamId,
    input.expectedHead,
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(`Workstream discovery projection HEAD changed: ${input.workstreamId}`);
  }
  database.prepare("DELETE FROM workstream_search WHERE workstream_id = ?").run(input.workstreamId);
  database.prepare([
    "INSERT INTO workstream_search(workstream_id, title, objective, current_request)",
    "VALUES (?, ?, ?, ?)",
  ].join(" ")).run(
    input.workstreamId,
    input.title,
    input.objective,
    current?.searchText ?? "",
  );
}

export function recordWorkstreamAccess(input: {
  database: ContextDatabase;
  workstreamId: string;
  runId: string;
  kind: "opened" | "bound";
  at: string;
}): boolean {
  const result = input.database.prepare([
    "INSERT INTO workstream_accesses(workstream_id, run_id, access_kind, accessed_at)",
    "VALUES (?, ?, ?, ?)",
    "ON CONFLICT(workstream_id, run_id, access_kind) DO NOTHING",
  ].join(" ")).run(input.workstreamId, input.runId, input.kind, input.at);
  return Number(result.changes) === 1;
}

export function setWorkstreamStar(input: {
  database: ContextDatabase;
  workstreamId: string;
  starred: boolean;
  at: string;
}): SetWorkstreamStarResponse {
  input.database.prepare([
    "INSERT INTO workstream_preferences(workstream_id, starred, starred_at, updated_at)",
    "VALUES (?, ?, ?, ?)",
    "ON CONFLICT(workstream_id) DO UPDATE SET",
    "starred = excluded.starred, starred_at = excluded.starred_at, updated_at = excluded.updated_at",
  ].join(" ")).run(
    input.workstreamId,
    input.starred ? 1 : 0,
    input.starred ? input.at : null,
    input.at,
  );
  return {
    workstreamId: input.workstreamId,
    starred: input.starred,
    ...(input.starred ? { starredAt: input.at } : {}),
  };
}

export function readPreviousBoundWorkstreamId(
  database: ContextDatabase,
  streamId: string,
  excludingRunId?: string,
): string | undefined {
  const row = database.prepare([
    "SELECT r.workstream_id FROM runs r",
    "WHERE r.stream_id = ? AND r.workstream_id IS NOT NULL",
    ...(excludingRunId ? ["AND r.run_id != ?"] : []),
    "ORDER BY r.run_sequence DESC, r.run_id DESC LIMIT 1",
  ].join(" ")).get(
    streamId,
    ...(excludingRunId ? [excludingRunId] : []),
  ) as { workstream_id: string } | undefined;
  return row?.workstream_id;
}
