import type {
  PlanWorkstreamRequestRouteResponse,
  WorkstreamRequestRoute,
  WorkstreamRequestRoutePlanPhase,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import type { WorkstreamRequestChangePlan } from "../workstreams/workstream-request-lifecycle.js";

interface WorkstreamRequestRoutePlanRow {
  run_id: string;
  operation_request_id: string;
  session_id: string;
  conversation_id: string;
  workstream_id: string;
  bound_request_id: string;
  base_head: string;
  route_json: string;
  change_plan_json: string | null;
  phase: WorkstreamRequestRoutePlanPhase;
  commit_head: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface WorkstreamRequestRoutePlanRecord {
  runId: string;
  operationRequestId: string;
  sessionId: string;
  conversationId: string;
  workstreamId: string;
  boundRequestId: string;
  baseHead: string;
  route: WorkstreamRequestRoute;
  changePlan?: WorkstreamRequestChangePlan;
  phase: WorkstreamRequestRoutePlanPhase;
  commitHead?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export function insertWorkstreamRequestRoutePlan(
  database: ContextDatabase,
  input: {
    runId: string;
    operationRequestId: string;
    sessionId: string;
    conversationId: string;
    workstreamId: string;
    boundRequestId: string;
    baseHead: string;
    route: WorkstreamRequestRoute;
    changePlan?: WorkstreamRequestChangePlan;
    at: string;
  },
): WorkstreamRequestRoutePlanRecord {
  const blocking = readBlockingWorkstreamRequestRoutePlan(database, input.workstreamId);
  if (blocking) {
    throw new GitContextServiceError({
      code: blocking.runId === input.runId ? "INVALID_REQUEST" : "WORKSTREAM_LOCKED",
      message: blocking.runId === input.runId
        ? "Run already has a pending request plan."
        : "Workstream already has a pending request plan.",
      retryable: blocking.runId !== input.runId,
      details: {
        workstreamId: input.workstreamId,
        runId: blocking.runId,
        phase: blocking.phase,
      },
    });
  }
  database.prepare([
    "INSERT INTO workstream_request_route_plans(",
    "run_id, operation_request_id, session_id, conversation_id, workstream_id, bound_request_id,",
    "base_head, route_json, change_plan_json, phase, commit_head, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, NULL)",
  ].join(" ")).run(
    input.runId,
    input.operationRequestId,
    input.sessionId,
    input.conversationId,
    input.workstreamId,
    input.boundRequestId,
    input.baseHead,
    JSON.stringify(input.route),
    input.changePlan ? JSON.stringify(input.changePlan) : null,
    input.at,
    input.at,
  );
  const record = readWorkstreamRequestRoutePlan(database, input.runId);
  if (!record) throw new Error("Inserted workstream request route plan could not be read.");
  return record;
}

export function readWorkstreamRequestRoutePlan(
  database: ContextDatabase,
  runId: string,
): WorkstreamRequestRoutePlanRecord | undefined {
  const row = database.prepare(routePlanSelect() + " WHERE run_id = ?")
    .get(runId) as WorkstreamRequestRoutePlanRow | undefined;
  return row ? routePlanRecord(row) : undefined;
}

export function readBlockingWorkstreamRequestRoutePlan(
  database: ContextDatabase,
  workstreamId: string,
): WorkstreamRequestRoutePlanRecord | undefined {
  const row = database.prepare([
    routePlanSelect(),
    "WHERE workstream_id = ? AND phase IN ('planned', 'recovery_required') LIMIT 1",
  ].join(" ")).get(workstreamId) as WorkstreamRequestRoutePlanRow | undefined;
  return row ? routePlanRecord(row) : undefined;
}

export function updateWorkstreamRequestRoutePlan(
  database: ContextDatabase,
  input: {
    runId: string;
    phase: WorkstreamRequestRoutePlanPhase;
    at: string;
    commitHead?: string;
    error?: string;
  },
): void {
  const result = database.prepare([
    "UPDATE workstream_request_route_plans SET phase = ?,",
    "commit_head = COALESCE(?, commit_head), updated_at = ?, last_error = ? WHERE run_id = ?",
  ].join(" ")).run(
    input.phase,
    input.commitHead ?? null,
    input.at,
    input.error ?? null,
    input.runId,
  );
  if (Number(result.changes) !== 1) {
    throw new Error("Workstream request route plan could not be updated: " + input.runId);
  }
}

export function workstreamRequestRoutePlanResponse(
  record: WorkstreamRequestRoutePlanRecord,
  run: PlanWorkstreamRequestRouteResponse["run"],
): PlanWorkstreamRequestRouteResponse {
  return {
    run,
    workstreamId: record.workstreamId,
    boundRequestId: record.boundRequestId,
    baseHead: record.baseHead,
    phase: record.phase,
    requestCreated: Boolean(record.changePlan),
  };
}

function routePlanSelect(): string {
  return [
    "SELECT run_id, operation_request_id, session_id, conversation_id, workstream_id,",
    "bound_request_id, base_head, route_json, change_plan_json, phase, commit_head,",
    "created_at, updated_at, last_error FROM workstream_request_route_plans",
  ].join(" ");
}

function routePlanRecord(row: WorkstreamRequestRoutePlanRow): WorkstreamRequestRoutePlanRecord {
  return {
    runId: row.run_id,
    operationRequestId: row.operation_request_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    workstreamId: row.workstream_id,
    boundRequestId: row.bound_request_id,
    baseHead: row.base_head,
    route: JSON.parse(row.route_json) as WorkstreamRequestRoute,
    ...(row.change_plan_json
      ? { changePlan: JSON.parse(row.change_plan_json) as WorkstreamRequestChangePlan }
      : {}),
    phase: row.phase,
    ...(row.commit_head ? { commitHead: row.commit_head } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
