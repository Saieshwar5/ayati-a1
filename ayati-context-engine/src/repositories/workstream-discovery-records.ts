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
  unfinishedRequests: Array<{
    id: string;
    title: string;
    status: "queued" | "active" | "blocked";
  }>;
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
  aliases?: string[];
  currentSnapshot?: string;
  currentFocus?: string;
  importantFindings?: string[];
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external" | "unavailable";
  currentRequest?: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked" | "done" | "dropped";
    searchText: string;
  };
}

interface Row {
  workstream_id: string;
  branch: "main";
  last_commit_sha: string;
  title: string;
  purpose: string;
  status: "active" | "archived";
  lifecycle_status: "active" | "paused" | "archived";
  repository_health: string;
  current_request_id: string | null;
  current_request_title: string | null;
  current_request_status: WorkstreamDiscoveryRow["currentRequestStatus"] | null;
  last_activity_at: string;
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
    "SELECT t.workstream_id, rs.branch, t.last_commit_sha, t.title, t.purpose,",
    "t.status, t.lifecycle_status, rs.repository_health, t.current_request_id,",
    "q.title AS current_request_title, q.status AS current_request_status,",
    "t.last_activity_at, COALESCE(p.starred, 0) AS starred, p.starred_at,",
    "MAX(a.accessed_at) AS last_opened_at,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' AND a.accessed_at >= ?",
    "  THEN a.run_id END) AS bound_runs_30d,",
    "COUNT(DISTINCT CASE WHEN a.access_kind = 'bound' THEN a.run_id END)",
    "  AS bound_runs_lifetime",
    "FROM workstreams t CROSS JOIN workstream_repository_state rs",
    "LEFT JOIN workstream_requests q ON q.workstream_id = t.workstream_id",
    "  AND q.request_id = t.current_request_id",
    "LEFT JOIN workstream_preferences p ON p.workstream_id = t.workstream_id",
    "LEFT JOIN workstream_accesses a ON a.workstream_id = t.workstream_id",
    "WHERE t.status IN ('active', 'archived') AND t.last_commit_sha IS NOT NULL",
    "GROUP BY t.workstream_id",
    "ORDER BY t.last_activity_at DESC, t.workstream_id DESC",
  ].join(" ")).all(cutoff) as unknown as Row[];
  const unfinishedRows = database.prepare([
    "SELECT workstream_id, request_id, title, status FROM workstream_requests",
    "WHERE status IN ('queued', 'active', 'blocked')",
    "ORDER BY workstream_id,",
    "CASE status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, request_id",
  ].join(" ")).all() as unknown as Array<{
    workstream_id: string;
    request_id: string;
    title: string;
    status: "queued" | "active" | "blocked";
  }>;
  const unfinished = new Map<string, WorkstreamDiscoveryRow["unfinishedRequests"]>();
  for (const request of unfinishedRows) {
    const requests = unfinished.get(request.workstream_id) ?? [];
    requests.push({
      id: request.request_id,
      title: request.title,
      status: request.status,
    });
    unfinished.set(request.workstream_id, requests);
  }
  return rows.map((row) => ({
    workstreamId: row.workstream_id,
    branch: row.branch,
    head: row.last_commit_sha,
    title: row.title,
    objective: row.purpose,
    status: row.status,
    lifecycleStatus: row.lifecycle_status,
    repositoryHealth: repositoryHealth(row.repository_health),
    ...(row.current_request_id && row.current_request_title && row.current_request_status
      ? {
          currentRequestId: row.current_request_id,
          currentRequestTitle: row.current_request_title,
          currentRequestStatus: row.current_request_status,
        }
      : {}),
    unfinishedRequests: unfinished.get(row.workstream_id) ?? [],
    updatedAt: row.last_activity_at,
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
    "ORDER BY bm25(workstream_search), workstream_id LIMIT ?",
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
  writeWorkstreamDiscoveryProjection(input.database, {
    workstreamId: input.workstream.workstreamId,
    expectedHead: input.workstream.head,
    title: input.context.title,
    objective: input.context.objective,
    lifecycleStatus: input.context.lifecycleStatus ?? "active",
    repositoryHealth: input.context.repositoryHealth ?? "ready",
    currentSnapshot: input.context.summary,
    currentFocus: input.context.currentFocus ?? "",
    ...(input.context.currentRequest ? {
      currentRequest: {
        id: input.context.currentRequest.id,
        title: input.context.currentRequest.title,
        status: input.context.currentRequest.status,
        searchText: [
          input.context.currentRequest.title,
          input.context.currentRequest.request,
          ...input.context.currentRequest.acceptance,
          ...input.context.currentRequest.constraints,
        ].join("\n"),
      },
    } : {}),
  });
}

export function writeWorkstreamDiscoveryProjection(
  database: ContextDatabase,
  input: WorkstreamDiscoveryProjectionWrite,
): void {
  const row = database.prepare([
    "SELECT aliases_json, current_snapshot, current_focus",
    "FROM workstreams WHERE workstream_id = ? AND last_commit_sha = ?",
  ].join(" ")).get(input.workstreamId, input.expectedHead) as {
    aliases_json: string;
    current_snapshot: string;
    current_focus: string;
  } | undefined;
  if (!row) {
    throw new Error("Workstream discovery projection revision changed: " + input.workstreamId);
  }
  const aliases = input.aliases ?? JSON.parse(row.aliases_json) as string[];
  const snapshot = input.currentSnapshot ?? row.current_snapshot;
  const focus = input.currentFocus ?? row.current_focus;
  const unfinished = database.prepare([
    "SELECT title, request_text, acceptance_json, constraints_json",
    "FROM workstream_requests",
    "WHERE workstream_id = ? AND status IN ('queued', 'active', 'blocked')",
    "ORDER BY request_id",
  ].join(" ")).all(input.workstreamId) as unknown as Array<{
    title: string;
    request_text: string;
    acceptance_json: string;
    constraints_json: string;
  }>;
  const resources = database.prepare([
    "SELECT r.display_name, r.description, r.aliases_json, r.locator_json",
    "FROM workstream_resources wr JOIN resources r ON r.resource_id = wr.resource_id",
    "WHERE wr.workstream_id = ? ORDER BY wr.last_used_at DESC LIMIT 50",
  ].join(" ")).all(input.workstreamId) as unknown as Array<{
    display_name: string;
    description: string;
    aliases_json: string;
    locator_json: string;
  }>;
  const progress = database.prepare([
    "SELECT summary, validation_summary, COALESCE(next_action, '') AS next_action",
    "FROM workstream_progress WHERE workstream_id = ?",
    "ORDER BY finalized_at DESC LIMIT 5",
  ].join(" ")).all(input.workstreamId) as unknown as Array<{
    summary: string;
    validation_summary: string;
    next_action: string;
  }>;
  database.prepare("DELETE FROM workstream_search WHERE workstream_id = ?")
    .run(input.workstreamId);
  database.prepare([
    "INSERT INTO workstream_search(",
    "workstream_id, title, aliases, purpose, current_snapshot, current_focus,",
    "findings, unfinished_requests, resources, recent_progress",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(" ")).run(
    input.workstreamId,
    input.title,
    aliases.join("\n"),
    input.objective,
    snapshot,
    focus,
    (input.importantFindings ?? []).join("\n"),
    unfinished.flatMap((request) => [
      request.title,
      request.request_text,
      ...(JSON.parse(request.acceptance_json) as string[]),
      ...(JSON.parse(request.constraints_json) as string[]),
    ]).join("\n"),
    resources.flatMap((resource) => [
      resource.display_name,
      resource.description,
      ...(JSON.parse(resource.aliases_json) as string[]),
      resource.locator_json,
    ]).join("\n"),
    progress.flatMap((entry) => [
      entry.summary,
      entry.validation_summary,
      entry.next_action,
    ]).join("\n"),
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
    "starred = excluded.starred, starred_at = excluded.starred_at,",
    "updated_at = excluded.updated_at",
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

function repositoryHealth(
  value: string,
): WorkstreamDiscoveryRow["repositoryHealth"] {
  if (value === "ready") return "ready";
  if (value === "dirty_external") return "dirty_external";
  return "unavailable";
}
