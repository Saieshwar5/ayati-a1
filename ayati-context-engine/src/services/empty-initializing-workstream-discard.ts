import type { WorkstreamCompletionRecord } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { clearAgentStreamWorkstreamFocus } from "../repositories/agent-stream-records.js";
import { detachRunFromEmptyInitializingWorkstream } from "../repositories/run-records.js";

interface DiscardableWorkstreamRow {
  stream_id: string;
  workstream_id: string;
  bound_request_id: string;
  status: string;
  last_commit_sha: string | null;
  created_by_run_id: string | null;
  route_phase: string | null;
}

export function shouldDiscardEmptyInitializingWorkstream(input: {
  database: ContextDatabase;
  runId: string;
  workstreamId: string;
  requestId: string;
  completion: WorkstreamCompletionRecord;
}): boolean {
  if (input.completion.resources.length > 0 || (input.completion.effects?.length ?? 0) > 0) {
    return false;
  }
  const row = readDiscardableWorkstream(input.database, input.runId);
  if (!row
    || row.workstream_id !== input.workstreamId
    || row.bound_request_id !== input.requestId
    || row.status !== "initializing"
    || row.last_commit_sha !== null
    || row.created_by_run_id !== input.runId
    || row.route_phase !== "planned") {
    return false;
  }
  return !hasDurableWorkstreamEvidence(input.database, input.workstreamId);
}

export function discardEmptyInitializingWorkstream(input: {
  database: ContextDatabase;
  runId: string;
  workstreamId: string;
  requestId: string;
  at: string;
}): void {
  const row = readDiscardableWorkstream(input.database, input.runId);
  if (!row
    || row.workstream_id !== input.workstreamId
    || row.bound_request_id !== input.requestId
    || row.status !== "initializing"
    || row.last_commit_sha !== null
    || row.created_by_run_id !== input.runId
    || row.route_phase !== "planned"
    || hasDurableWorkstreamEvidence(input.database, input.workstreamId)) {
    throw new ContextEngineServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Initializing workstream discard requires the creating run and no durable resources.",
      details: {
        runId: input.runId,
        workstreamId: input.workstreamId,
        requestId: input.requestId,
      },
    });
  }

  clearAgentStreamWorkstreamFocus(input.database, {
    streamId: row.stream_id,
    workstreamId: input.workstreamId,
    requestId: input.requestId,
    at: input.at,
  });
  input.database.prepare("DELETE FROM workstream_request_search WHERE workstream_id = ?")
    .run(input.workstreamId);
  input.database.prepare("DELETE FROM workstream_search WHERE workstream_id = ?")
    .run(input.workstreamId);
  detachRunFromEmptyInitializingWorkstream(input.database, input);
  input.database.prepare("DELETE FROM workstream_request_route_plans WHERE run_id = ?")
    .run(input.runId);
  const deleted = input.database.prepare([
    "DELETE FROM workstreams WHERE workstream_id = ? AND status = 'initializing'",
    "AND last_commit_sha IS NULL AND created_by_run_id = ?",
  ].join(" ")).run(input.workstreamId, input.runId);
  if (Number(deleted.changes) !== 1) {
    throw new ContextEngineServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Empty initializing workstream could not be discarded safely.",
      details: { runId: input.runId, workstreamId: input.workstreamId },
    });
  }
}

function readDiscardableWorkstream(
  database: ContextDatabase,
  runId: string,
): DiscardableWorkstreamRow | undefined {
  return database.prepare([
    "SELECT r.stream_id, r.workstream_id, r.bound_request_id, w.status,",
    "w.last_commit_sha, w.created_by_run_id, p.phase AS route_phase",
    "FROM runs r JOIN workstreams w ON w.workstream_id = r.workstream_id",
    "LEFT JOIN workstream_request_route_plans p ON p.run_id = r.run_id",
    "WHERE r.run_id = ? AND r.status = 'running'",
  ].join(" ")).get(runId) as DiscardableWorkstreamRow | undefined;
}

function hasDurableWorkstreamEvidence(
  database: ContextDatabase,
  workstreamId: string,
): boolean {
  const row = database.prepare([
    "SELECT",
    "EXISTS(SELECT 1 FROM workstream_resources WHERE workstream_id = ?) AS has_resources,",
    "EXISTS(SELECT 1 FROM request_resources WHERE workstream_id = ?) AS has_request_resources,",
    "EXISTS(SELECT 1 FROM resource_events WHERE workstream_id = ?) AS has_events,",
    "EXISTS(SELECT 1 FROM resource_mutation_leases WHERE workstream_id = ?) AS has_leases,",
    "EXISTS(SELECT 1 FROM workstream_progress WHERE workstream_id = ?) AS has_progress,",
    "EXISTS(SELECT 1 FROM workstream_finalizations WHERE workstream_id = ?)",
    "AS has_finalizations",
  ].join(" ")).get(
    workstreamId,
    workstreamId,
    workstreamId,
    workstreamId,
    workstreamId,
    workstreamId,
  ) as {
    has_resources: number;
    has_request_resources: number;
    has_events: number;
    has_leases: number;
    has_progress: number;
    has_finalizations: number;
  };
  return Object.values(row).some(Boolean);
}
