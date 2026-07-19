import type {
  SetTaskStarResponse,
  TaskCatalogEntry,
  TaskContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export interface TaskDiscoveryRow {
  taskId: string;
  repositoryPath: string;
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

export interface TaskDiscoveryProjectionWrite {
  taskId: string;
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

interface TaskDiscoveryDatabaseRow {
  task_id: string;
  repository_path: string;
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

export function readTaskDiscoveryRows(
  database: ContextDatabase,
  cutoff: string,
): TaskDiscoveryRow[] {
  const rows = database.prepare([
    "SELECT t.task_id, t.repository_path, t.branch, t.head_sha,",
    "t.title_cache, t.objective_cache, t.status, t.lifecycle_status,",
    "t.repository_health, t.current_request_id, t.current_request_title,",
    "t.current_request_status, t.updated_at,",
    "COALESCE(p.starred, 0) AS starred, p.starred_at,",
    "MAX(a.accessed_at) AS last_opened_at,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' AND a.accessed_at >= ?",
    "  THEN a.run_id END) AS bound_runs_30d,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' THEN a.run_id END)",
    "  AS bound_runs_lifetime",
    "FROM tasks t",
    "LEFT JOIN task_preferences p ON p.task_id = t.task_id",
    "LEFT JOIN task_accesses a ON a.task_id = t.task_id",
    "WHERE t.status != 'initializing' AND t.head_sha IS NOT NULL",
    "GROUP BY t.task_id",
    "ORDER BY t.updated_at DESC, t.task_id DESC",
  ].join(" ")).all(cutoff) as unknown as TaskDiscoveryDatabaseRow[];
  return rows.map((row) => ({
    taskId: row.task_id,
    repositoryPath: row.repository_path,
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

export function searchTaskIds(
  database: ContextDatabase,
  matchExpression: string,
  limit: number,
): string[] {
  if (!matchExpression) return [];
  const rows = database.prepare([
    "SELECT task_id FROM task_search",
    "WHERE task_search MATCH ?",
    "ORDER BY bm25(task_search), task_id",
    "LIMIT ?",
  ].join(" ")).all(matchExpression, limit) as unknown as Array<{ task_id: string }>;
  return rows.map((row) => row.task_id);
}

export function refreshTaskDiscoveryProjection(input: {
  database: ContextDatabase;
  task: TaskCatalogEntry;
  context: TaskContextProjection;
}): void {
  if (input.context.task.head !== input.task.head
    || input.context.task.branch !== input.task.branch) {
    return;
  }
  const current = input.context.currentRequest;
  const existing = input.database.prepare([
    "SELECT title_cache, objective_cache, lifecycle_status, repository_health,",
    "current_request_id, current_request_title, current_request_status",
    "FROM tasks WHERE task_id = ?",
  ].join(" ")).get(input.task.taskId) as {
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
    "SELECT 1 AS found FROM task_search WHERE task_id = ? LIMIT 1",
  ).get(input.task.taskId) as { found: number } | undefined;
  if (!projectionChanged && searchExists) return;
  input.database.transaction(() => {
    writeTaskDiscoveryProjection(input.database, {
      taskId: input.task.taskId,
      expectedHead: input.task.head,
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

export function writeTaskDiscoveryProjection(
  database: ContextDatabase,
  input: TaskDiscoveryProjectionWrite,
): void {
  const current = input.currentRequest;
  const updated = database.prepare([
    "UPDATE tasks SET title_cache = ?, objective_cache = ?, lifecycle_status = ?,",
    "repository_health = ?, current_request_id = ?, current_request_title = ?,",
    "current_request_status = ? WHERE task_id = ? AND head_sha = ?",
  ].join(" ")).run(
    input.title,
    input.objective,
    input.lifecycleStatus,
    input.repositoryHealth,
    current?.id ?? null,
    current?.title ?? null,
    current?.status ?? null,
    input.taskId,
    input.expectedHead,
  );
  if (Number(updated.changes) !== 1) {
    throw new Error(`Task discovery projection HEAD changed: ${input.taskId}`);
  }
  const repository = database.prepare(
    "SELECT repository_path FROM tasks WHERE task_id = ?",
  ).get(input.taskId) as { repository_path: string } | undefined;
  if (!repository) throw new Error(`Task discovery projection is missing: ${input.taskId}`);
  database.prepare("DELETE FROM task_search WHERE task_id = ?").run(input.taskId);
  database.prepare([
    "INSERT INTO task_search(task_id, title, objective, current_request, repository_path)",
    "VALUES (?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.taskId,
    input.title,
    input.objective,
    current?.searchText ?? "",
    repository.repository_path,
  );
}

export function recordTaskAccess(input: {
  database: ContextDatabase;
  taskId: string;
  runId: string;
  kind: "opened" | "bound";
  at: string;
}): boolean {
  const result = input.database.prepare([
    "INSERT INTO task_accesses(task_id, run_id, access_kind, accessed_at)",
    "VALUES (?, ?, ?, ?)",
    "ON CONFLICT(task_id, run_id, access_kind) DO NOTHING",
  ].join(" ")).run(input.taskId, input.runId, input.kind, input.at);
  return Number(result.changes) === 1;
}

export function setTaskStar(input: {
  database: ContextDatabase;
  taskId: string;
  starred: boolean;
  at: string;
}): SetTaskStarResponse {
  input.database.prepare([
    "INSERT INTO task_preferences(task_id, starred, starred_at, updated_at)",
    "VALUES (?, ?, ?, ?)",
    "ON CONFLICT(task_id) DO UPDATE SET",
    "starred = excluded.starred, starred_at = excluded.starred_at, updated_at = excluded.updated_at",
  ].join(" ")).run(
    input.taskId,
    input.starred ? 1 : 0,
    input.starred ? input.at : null,
    input.at,
  );
  return {
    taskId: input.taskId,
    starred: input.starred,
    ...(input.starred ? { starredAt: input.at } : {}),
  };
}

export function readPreviousBoundTaskId(
  database: ContextDatabase,
  sessionId: string,
  excludingRunId?: string,
): string | undefined {
  const row = database.prepare([
    "SELECT r.task_id FROM runs r",
    "JOIN sessions owner ON owner.session_id = r.session_id",
    "JOIN sessions current ON current.session_id = ? AND current.agent_id = owner.agent_id",
    "WHERE r.task_id IS NOT NULL",
    ...(excludingRunId ? ["AND r.run_id != ?"] : []),
    "ORDER BY owner.date DESC, r.run_sequence DESC, r.run_id DESC LIMIT 1",
  ].join(" ")).get(
    sessionId,
    ...(excludingRunId ? [excludingRunId] : []),
  ) as { task_id: string } | undefined;
  return row?.task_id;
}
