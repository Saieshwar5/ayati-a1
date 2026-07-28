import type {
  RecentWorkstreamActivityKind,
  RecentWorkstreamMetadata,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

const MAX_RECENT_WORKSTREAMS = 10;

interface RecentWorkstreamRow {
  workstream_id: string;
  title: string;
  lifecycle_status: "active" | "paused" | "archived";
  repository_health: "ready" | "dirty_external" | "unavailable";
  current_request_id: string | null;
  current_request_title: string | null;
  current_request_status: "queued" | "active" | "blocked" | "done" | "dropped" | null;
  last_activity_kind: RecentWorkstreamActivityKind;
  last_activity_at: string;
}

export function readRecentWorkstreams(
  database: ContextDatabase,
  limit = MAX_RECENT_WORKSTREAMS,
): RecentWorkstreamMetadata[] {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_WORKSTREAMS);
  const rows = database.prepare([
    "SELECT t.workstream_id, t.title, t.lifecycle_status,",
    "CASE WHEN rs.repository_health IN ('ready', 'dirty_external')",
    "  THEN rs.repository_health ELSE 'unavailable' END AS repository_health,",
    "t.current_request_id, q.title AS current_request_title,",
    "q.status AS current_request_status,",
    "CASE WHEN latest.accessed_at > t.created_at THEN latest.access_kind",
    "  ELSE 'created' END AS last_activity_kind,",
    "CASE WHEN latest.accessed_at > t.created_at THEN latest.accessed_at",
    "  ELSE t.created_at END AS last_activity_at",
    "FROM workstreams t CROSS JOIN workstream_repository_state rs",
    "LEFT JOIN workstream_requests q ON q.workstream_id = t.workstream_id",
    "  AND q.request_id = t.current_request_id",
    "LEFT JOIN workstream_accesses latest ON latest.rowid = (",
    "  SELECT access.rowid FROM workstream_accesses access",
    "  WHERE access.workstream_id = t.workstream_id",
    "  ORDER BY access.accessed_at DESC,",
    "    CASE access.access_kind WHEN 'bound' THEN 0 ELSE 1 END,",
    "    access.run_id DESC LIMIT 1",
    ")",
    "WHERE t.status IN ('active', 'archived') AND t.last_commit_sha IS NOT NULL",
    "ORDER BY last_activity_at DESC, t.workstream_id DESC",
    "LIMIT ?",
  ].join(" ")).all(boundedLimit) as unknown as RecentWorkstreamRow[];

  return rows.map((row) => ({
    workstreamId: row.workstream_id,
    title: row.title,
    lifecycleStatus: row.lifecycle_status,
    repositoryHealth: row.repository_health,
    ...(row.current_request_id
      && row.current_request_title
      && row.current_request_status
      ? {
          currentRequest: {
            id: row.current_request_id,
            title: row.current_request_title,
            status: row.current_request_status,
          },
        }
      : {}),
    lastActivity: {
      kind: row.last_activity_kind,
      at: row.last_activity_at,
    },
  }));
}
