import type {
  RecentWorkStateHandoff,
  RunOutcome,
  RunStopReason,
} from "../contracts.js";
import type {
  RunImportantContextItem,
  RunWorkPlanItem,
  RunWorkStateUpdateReason,
  RunWorkStatus,
} from "../run-work-state-contracts.js";
import type { ContextDatabase } from "../database/database.js";

export const MAX_RECENT_WORK_STATE_HANDOFFS = 5;

interface RecentWorkStateRow {
  run_id: string;
  request_seq: number | null;
  response_seq: number | null;
  completed_at: string;
  run_status: RunOutcome;
  stop_reason: RunStopReason;
  work_status: RunWorkStatus;
  summary: string;
  plan_json: string;
  important_context_json: string;
  next_action: string | null;
  update_reason: RunWorkStateUpdateReason;
  work_state_updated_at: string;
  workstream_id: string | null;
  workstream_title: string | null;
  bound_request_id: string | null;
  request_title: string | null;
}

export function readRecentWorkStateHandoffs(
  database: ContextDatabase,
  input: {
    streamId: string;
    limit?: number;
  },
): RecentWorkStateHandoff[] {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? MAX_RECENT_WORK_STATE_HANDOFFS), 1),
    MAX_RECENT_WORK_STATE_HANDOFFS,
  );
  const rows = database.prepare([
    "SELECT r.run_id, r.completed_at, r.status AS run_status,",
    "r.stop_reason, r.workstream_id, r.bound_request_id,",
    "ws.status AS work_status, ws.summary, ws.plan_json,",
    "ws.important_context_json, ws.next_action, ws.update_reason,",
    "ws.updated_at AS work_state_updated_at,",
    "(SELECT request.sequence FROM messages request",
    "  WHERE request.run_id = r.run_id AND request.role != 'assistant'",
    "  ORDER BY request.sequence LIMIT 1) AS request_seq,",
    "(SELECT response.sequence FROM messages response",
    "  WHERE response.run_id = r.run_id AND response.role = 'assistant'",
    "  ORDER BY response.sequence DESC LIMIT 1) AS response_seq,",
    "w.title_cache AS workstream_title,",
    "CASE WHEN w.current_request_id = r.bound_request_id",
    "  THEN w.current_request_title ELSE NULL END AS request_title",
    "FROM runs r",
    "JOIN run_work_state ws ON ws.run_id = r.run_id",
    "LEFT JOIN workstreams w ON w.workstream_id = r.workstream_id",
    "WHERE r.stream_id = ?",
    "  AND r.status NOT IN ('running', 'recovery_required')",
    "  AND ws.update_reason <> 'initial'",
    "  AND (",
    "    r.workstream_id IS NOT NULL",
    "    OR r.status <> 'done'",
    "    OR ws.plan_json <> '[]'",
    "    OR ws.important_context_json <> '[]'",
    "    OR NULLIF(TRIM(ws.next_action), '') IS NOT NULL",
    "  )",
    "ORDER BY r.completed_at DESC, r.run_sequence DESC",
    "LIMIT ?",
  ].join(" ")).all(
    input.streamId,
    limit,
  ) as unknown as RecentWorkStateRow[];

  return rows.map(recentWorkStateHandoff);
}

function recentWorkStateHandoff(
  row: RecentWorkStateRow,
): RecentWorkStateHandoff {
  return {
    runId: row.run_id,
    sourceRef: `run:${row.run_id}`,
    ...(row.request_seq !== null ? { requestSeq: Number(row.request_seq) } : {}),
    ...(row.response_seq !== null ? { responseSeq: Number(row.response_seq) } : {}),
    completedAt: row.completed_at,
    runStatus: row.run_status,
    stopReason: row.stop_reason,
    workState: {
      status: row.work_status,
      summary: row.summary,
      plan: parseJsonArray<RunWorkPlanItem>(row.plan_json),
      importantContext: parseJsonArray<RunImportantContextItem>(
        row.important_context_json,
      ),
      ...(row.next_action ? { nextAction: row.next_action } : {}),
      updateReason: row.update_reason,
      updatedAt: row.work_state_updated_at,
    },
    ...(row.workstream_id
      && row.workstream_title
      && row.bound_request_id
      ? {
          workstream: {
            workstreamId: row.workstream_id,
            title: row.workstream_title,
            requestId: row.bound_request_id,
            ...(row.request_title ? { requestTitle: row.request_title } : {}),
          },
        }
      : {}),
  };
}

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}
