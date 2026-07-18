import type {
  PlanTaskRequestRouteRequest,
  PlanTaskRequestRouteResponse,
  TaskContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  insertTaskRequestRoutePlan,
  readTaskRequestRoutePlan,
  taskRequestRoutePlanResponse,
} from "../repositories/task-request-route-plan-records.js";
import {
  bindActiveRunToTask,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readTaskInitialization } from "../repositories/task-records.js";
import { planTaskRequestChange } from "../tasks/task-request-lifecycle.js";
import { resolvePlannedTaskRequestState } from "../tasks/planned-task-request.js";
import { resolveTaskRequestRoutingDecision } from "../tasks/task-request-routing.js";
import { validateTaskRepository } from "../tasks/task-repository-validator.js";

export class TaskRequestRoutingService {
  constructor(private readonly options: {
    database: ContextDatabase;
    taskRoot: string;
  }) {}

  async plan(input: PlanTaskRequestRouteRequest): Promise<PlanTaskRequestRouteResponse> {
    const task = readTaskInitialization(this.options.database, input.taskId);
    if (!task?.head || task.status !== "active") {
      throw invalid("Request planning requires an active V1 task repository.", input);
    }
    if (task.head !== input.expectedTaskHead) {
      throw new GitContextServiceError({
        code: "TASK_HEAD_MISMATCH",
        message: "Task HEAD does not match the request plan expectation.",
        retryable: true,
        details: {
          taskId: input.taskId,
          expectedHead: input.expectedTaskHead,
          actualHead: task.head,
        },
      });
    }
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running" || run.sessionId !== input.sessionId
      || run.conversationId !== input.conversationId
      || (run.taskId && run.taskId !== input.taskId)) {
      throw invalid("Request planning requires the matching active session run.", input);
    }
    const existingPlan = readTaskRequestRoutePlan(this.options.database, input.runId);
    if (existingPlan && existingPlan.requestId !== input.requestId) {
      throw invalid("Active run already owns a different task request plan.", input);
    }
    if (run.taskRequestId && !existingPlan) {
      throw invalid("Active run is already bound without a recoverable request plan.", input);
    }
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath: task.repositoryPath,
      expectedTaskId: input.taskId,
      requestReadMode: "all",
    });
    if (validation.head !== input.expectedTaskHead || validation.branch !== task.branch) {
      throw new GitContextServiceError({
        code: "TASK_HEAD_MISMATCH",
        message: "Task repository identity changed before request planning.",
        retryable: true,
        details: {
          taskId: input.taskId,
          expectedHead: input.expectedTaskHead,
          actualHead: validation.head,
        },
      });
    }
    if (validation.health !== "ready") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "V1 request planning requires a clean task repository.",
        details: { taskId: input.taskId, workingTreeChanges: validation.workingTreeChanges },
      });
    }
    const state = {
      expectedHead: validation.head,
      taskCard: validation.taskCard,
      requests: validation.requests,
    };
    const decision = input.route.kind === "continue_active_request"
      ? {
          kind: input.route.kind,
          taskId: input.taskId,
          requestId: input.route.requestId,
          reason: input.route.reason,
        } as const
      : {
          kind: input.route.kind,
          taskId: input.taskId,
          reason: input.route.reason,
        } as const;
    const resolution = resolveTaskRequestRoutingDecision({
      tasks: [state],
      evidence: { explicitTaskId: input.taskId },
    }, decision);
    if (resolution.status !== "ready"
      || (resolution.next !== "continue_request" && resolution.next !== "create_active_request")) {
      throw new GitContextServiceError({
        code: "TASK_CURRENT_REQUEST_INVALID",
        message: "Request route is not ready for mutation.",
        retryable: true,
        details: { taskId: input.taskId, resolution },
      });
    }
    const changePlan = input.route.kind === "create_active_request"
      ? planTaskRequestChange(state, {
          kind: "create",
          title: input.route.title,
          request: input.route.request,
          acceptance: input.route.acceptance,
          constraints: input.route.constraints,
          source: "user",
          createdAt: input.at,
          activate: true,
        })
      : undefined;
    const taskRequestId = changePlan?.primaryRequestId
      ?? (input.route.kind === "continue_active_request" ? input.route.requestId : undefined);
    if (!taskRequestId) throw new Error("Resolved request route is missing its request identity.");
    const pending = beginRecoverableIdempotent<PlanTaskRequestRouteResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "plan_task_request_route",
      payload: input,
      now: input.at,
      execute: () => {
        const record = insertTaskRequestRoutePlan(this.options.database, {
          runId: input.runId,
          requestId: input.requestId,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          taskRequestId,
          baseHead: input.expectedTaskHead,
          route: input.route,
          ...(changePlan ? { changePlan } : {}),
          at: input.at,
        });
        const boundRun = bindActiveRunToTask(
          this.options.database,
          input.sessionId,
          input.runId,
          input.taskId,
          taskRequestId,
        );
        return taskRequestRoutePlanResponse(record, boundRun);
      },
    });
    if (pending.completed) return pending.result;
    return completeRecoverableIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      result: pending.result,
      now: input.at,
    });
  }

  async projectContext(runId: string, context: TaskContextProjection): Promise<TaskContextProjection> {
    const record = readTaskRequestRoutePlan(this.options.database, runId);
    if (!record || (record.phase !== "planned" && record.phase !== "authority_acquired")) {
      return context;
    }
    const validation = await validateTaskRepository({
      taskRoot: this.options.taskRoot,
      repositoryPath: context.task.repositoryPath,
      expectedTaskId: context.task.taskId,
      requestReadMode: "all",
    });
    const planned = resolvePlannedTaskRequestState(record, validation);
    return {
      ...context,
      lifecycleStatus: planned.taskCard.status,
      currentFocus: planned.taskCard.currentFocus,
      blockers: [...planned.taskCard.blockers],
      currentRequest: structuredClone(planned.taskRequest),
    };
  }
}

function invalid(
  message: string,
  input: Pick<PlanTaskRequestRouteRequest, "sessionId" | "runId" | "taskId">,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    details: { sessionId: input.sessionId, runId: input.runId, taskId: input.taskId },
  });
}
