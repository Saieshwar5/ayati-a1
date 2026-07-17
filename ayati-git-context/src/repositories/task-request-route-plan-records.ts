import type {
  PlanTaskRequestRouteResponse,
  TaskRequestRoute,
  TaskRequestRoutePlanPhase,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import type { TaskRequestChangePlan } from "../tasks/task-request-lifecycle.js";

interface TaskRequestRoutePlanRow {
  run_id: string;
  request_id: string;
  session_id: string;
  conversation_id: string;
  task_id: string;
  task_request_id: string;
  base_head: string;
  route_json: string;
  change_plan_json: string | null;
  phase: TaskRequestRoutePlanPhase;
  authority_id: string | null;
  commit_head: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface TaskRequestRoutePlanRecord {
  runId: string;
  requestId: string;
  sessionId: string;
  conversationId: string;
  taskId: string;
  taskRequestId: string;
  baseHead: string;
  route: TaskRequestRoute;
  changePlan?: TaskRequestChangePlan;
  phase: TaskRequestRoutePlanPhase;
  authorityId?: string;
  commitHead?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export function insertTaskRequestRoutePlan(
  database: ContextDatabase,
  input: {
    runId: string;
    requestId: string;
    sessionId: string;
    conversationId: string;
    taskId: string;
    taskRequestId: string;
    baseHead: string;
    route: TaskRequestRoute;
    changePlan?: TaskRequestChangePlan;
    at: string;
  },
): TaskRequestRoutePlanRecord {
  const blocking = readBlockingTaskRequestRoutePlan(database, input.taskId);
  if (blocking) {
    throw new GitContextServiceError({
      code: blocking.runId === input.runId ? "INVALID_REQUEST" : "TASK_LOCKED",
      message: blocking.runId === input.runId
        ? "Run already has a pending request plan."
        : "Task already has a pending request plan.",
      retryable: blocking.runId !== input.runId,
      details: {
        taskId: input.taskId,
        runId: blocking.runId,
        phase: blocking.phase,
      },
    });
  }
  database.prepare([
    "INSERT INTO task_request_route_plans(",
    "run_id, request_id, session_id, conversation_id, task_id, task_request_id,",
    "base_head, route_json, change_plan_json, phase, authority_id, commit_head,",
    "created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, ?, NULL)",
  ].join(" ")).run(
    input.runId,
    input.requestId,
    input.sessionId,
    input.conversationId,
    input.taskId,
    input.taskRequestId,
    input.baseHead,
    JSON.stringify(input.route),
    input.changePlan ? JSON.stringify(input.changePlan) : null,
    input.at,
    input.at,
  );
  const record = readTaskRequestRoutePlan(database, input.runId);
  if (!record) throw new Error("Inserted task request route plan could not be read.");
  return record;
}

export function readTaskRequestRoutePlan(
  database: ContextDatabase,
  runId: string,
): TaskRequestRoutePlanRecord | undefined {
  const row = database.prepare([
    routePlanSelect(),
    "WHERE run_id = ?",
  ].join(" ")).get(runId) as TaskRequestRoutePlanRow | undefined;
  return row ? routePlanRecord(row) : undefined;
}

export function readBlockingTaskRequestRoutePlan(
  database: ContextDatabase,
  taskId: string,
): TaskRequestRoutePlanRecord | undefined {
  const row = database.prepare([
    routePlanSelect(),
    "WHERE task_id = ? AND phase IN ('planned', 'authority_acquired', 'recovery_required')",
    "LIMIT 1",
  ].join(" ")).get(taskId) as TaskRequestRoutePlanRow | undefined;
  return row ? routePlanRecord(row) : undefined;
}

export function updateTaskRequestRoutePlan(
  database: ContextDatabase,
  input: {
    runId: string;
    phase: TaskRequestRoutePlanPhase;
    at: string;
    authorityId?: string;
    commitHead?: string;
    error?: string;
  },
): void {
  const result = database.prepare([
    "UPDATE task_request_route_plans",
    "SET phase = ?, authority_id = COALESCE(?, authority_id),",
    "commit_head = COALESCE(?, commit_head), updated_at = ?, last_error = ?",
    "WHERE run_id = ?",
  ].join(" ")).run(
    input.phase,
    input.authorityId ?? null,
    input.commitHead ?? null,
    input.at,
    input.error ?? null,
    input.runId,
  );
  if (Number(result.changes) !== 1) {
    throw new Error("Task request route plan could not be updated: " + input.runId);
  }
}

export function taskRequestRoutePlanResponse(
  record: TaskRequestRoutePlanRecord,
  run: PlanTaskRequestRouteResponse["run"],
): PlanTaskRequestRouteResponse {
  return {
    run,
    taskId: record.taskId,
    taskRequestId: record.taskRequestId,
    baseHead: record.baseHead,
    phase: record.phase,
    requestCreated: Boolean(record.changePlan),
  };
}

function routePlanSelect(): string {
  return [
    "SELECT run_id, request_id, session_id, conversation_id, task_id,",
    "task_request_id, base_head, route_json, change_plan_json, phase,",
    "authority_id, commit_head, created_at, updated_at, last_error",
    "FROM task_request_route_plans",
  ].join(" ");
}

function routePlanRecord(row: TaskRequestRoutePlanRow): TaskRequestRoutePlanRecord {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    taskRequestId: row.task_request_id,
    baseHead: row.base_head,
    route: JSON.parse(row.route_json) as TaskRequestRoute,
    ...(row.change_plan_json
      ? { changePlan: JSON.parse(row.change_plan_json) as TaskRequestChangePlan }
      : {}),
    phase: row.phase,
    ...(row.authority_id ? { authorityId: row.authority_id } : {}),
    ...(row.commit_head ? { commitHead: row.commit_head } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
