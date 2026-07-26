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
    "SELECT t.workstream_id, t.title_cache AS title, t.lifecycle_status,",
    "t.repository_health, t.current_request_id, t.current_request_title,",
    "t.current_request_status,",
    "CASE WHEN latest.accessed_at > t.created_at THEN latest.access_kind",
    "  ELSE 'created' END AS last_activity_kind,",
    "CASE WHEN latest.accessed_at > t.created_at THEN latest.accessed_at",
    "  ELSE t.created_at END AS last_activity_at",
    "FROM workstreams t",
    "LEFT JOIN workstream_accesses latest ON latest.rowid = (",
    "  SELECT access.rowid FROM workstream_accesses access",
    "  WHERE access.workstream_id = t.workstream_id",
    "  ORDER BY access.accessed_at DESC,",
    "    CASE access.access_kind WHEN 'bound' THEN 0 ELSE 1 END,",
    "    access.run_id DESC LIMIT 1",
    ")",
    "WHERE t.status IN ('active', 'archived') AND t.head_sha IS NOT NULL",
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
