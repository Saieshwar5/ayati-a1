import type {
  ActivateTaskForRunRequest,
  CreateTaskForRunRequest,
  SelectedTaskForRunResponse,
  TaskCatalogEntry,
  TaskRequestRoute,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readTaskRequestRoutePlan } from "../repositories/task-request-route-plan-records.js";
import { GitContextObserver } from "../observability.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { TaskRequestRoutingService } from "./task-request-routing-service.js";

export class TaskBindingService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly taskLifecycle: TaskLifecycleService,
    private readonly taskRequestRouting: TaskRequestRoutingService,
    private readonly observer: GitContextObserver = new GitContextObserver("git-context-engine"),
  ) {}

  async create(input: CreateTaskForRunRequest): Promise<SelectedTaskForRunResponse> {
    this.assertBindableRun(input);
    this.emitRequested(input, "create", "initial");
    const creation = await this.taskLifecycle.createSimpleTask({
      requestId: input.requestId + ":task",
      sessionId: input.sessionId,
      title: input.title,
      objective: input.objective,
      placement: input.placement,
      at: input.at,
    });
    this.emitValidated(input, creation.task, creation.created);
    return await this.select(
      input,
      creation.task,
      creation.created,
      {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the initial request created with the task.",
      },
      "initial",
    );
  }

  async activate(input: ActivateTaskForRunRequest): Promise<SelectedTaskForRunResponse> {
    this.assertBindableRun(input);
    if (!/^T-\d{8}-\d{4}$/.test(input.taskId)) {
      throw invalid("Task activation supports only V1 T-* task repositories.", input);
    }
    this.emitRequested(
      input,
      "activate",
      input.route.kind === "continue_active_request" ? "continue" : "create",
    );
    const response = await this.taskLifecycle.getTask({ taskId: input.taskId });
    if (input.expectedTaskHead && response.task.head !== input.expectedTaskHead) {
      throw new GitContextServiceError({
        code: "TASK_HEAD_MISMATCH",
        message: "Task changed after it was selected.",
        details: {
          taskId: input.taskId,
          expectedHead: input.expectedTaskHead,
          actualHead: response.task.head,
        },
      });
    }
    this.emitValidated(input, response.task, false);
    return await this.select(
      input,
      response.task,
      false,
      input.route,
      input.route.kind === "continue_active_request" ? "continue" : "create",
    );
  }

  private async select(
    input: CreateTaskForRunRequest | ActivateTaskForRunRequest,
    task: TaskCatalogEntry,
    taskCreated: boolean,
    route: TaskRequestRoute,
    taskRequestDecision: "initial" | "continue" | "create",
  ): Promise<SelectedTaskForRunResponse> {
    const headBeforeSelection = task.head;
    const planned = await this.taskRequestRouting.plan({
      requestId: input.requestId + ":route",
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      runId: input.runId,
      taskId: task.taskId,
      expectedTaskHead: task.head,
      route,
      at: input.at,
    });
    const context = await this.taskRequestRouting.projectContext(
      input.runId,
      await this.taskLifecycle.readContext(task),
    );
    const status = context.currentRequest?.status;
    if (!status) {
      throw new Error("Selected task context is missing its active request status.");
    }
    return {
      task,
      run: planned.run,
      context,
      taskCreated,
      taskRequestDecision,
      taskRequestStatus: status,
      taskRequestCreated: taskRequestDecision === "initial" ? true : planned.requestCreated,
      headBeforeSelection,
    };
  }

  private assertBindableRun(
    input: Pick<
      CreateTaskForRunRequest,
      "requestId" | "sessionId" | "conversationId" | "runId"
    >,
  ): void {
    const existing = readRunEvidence(this.database, input.runId);
    if (!existing
      || existing.status !== "running"
      || existing.sessionId !== input.sessionId
      || existing.conversationId !== input.conversationId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Task selection requires the matching active run and conversation.",
        details: input,
      });
    }
    if (existing.taskBinding) {
      const plan = readTaskRequestRoutePlan(this.database, input.runId);
      if (plan?.requestId === input.requestId + ":route") return;
      throw new GitContextServiceError({
        code: "RUN_TASK_BINDING_IMMUTABLE",
        message: "The active run already has an immutable task/request binding.",
        details: { runId: input.runId, taskBinding: existing.taskBinding },
      });
    }
  }

  private emitRequested(
    input: CreateTaskForRunRequest | ActivateTaskForRunRequest,
    mode: "create" | "activate",
    decision: "initial" | "continue" | "create",
  ): void {
    this.observer.emit({
      level: "info",
      event: "task_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      ...("taskId" in input ? { taskId: input.taskId } : {}),
      outcome: "started",
      data: { mode, taskRequestDecision: decision },
    });
  }

  private emitValidated(
    input: CreateTaskForRunRequest | ActivateTaskForRunRequest,
    task: TaskCatalogEntry,
    newlyCreated: boolean,
  ): void {
    this.observer.emit({
      level: "info",
      event: "task_repository_validated",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: task.taskId,
      outcome: "succeeded",
      data: {
        workingDirectory: task.workingPath,
        branch: task.branch,
        taskHead: task.head,
        newlyCreated,
      },
    });
  }
}

function invalid(
  message: string,
  input: { sessionId: string; runId: string; taskId?: string },
): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    details: {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
  });
}
