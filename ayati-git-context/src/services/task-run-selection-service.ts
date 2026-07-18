import type {
  ActivateTaskRunRequest,
  CreateTaskRunRequest,
  SelectedTaskRunResponse,
  TaskCatalogEntry,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRun } from "../repositories/run-records.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { SessionRunLifecycleService } from "./session-run-lifecycle-service.js";
import type { TaskRequestRoutingService } from "./task-request-routing-service.js";
import { GitContextObserver } from "../observability.js";

export class TaskRunSelectionService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly taskLifecycle: TaskLifecycleService,
    private readonly sessionRuns: SessionRunLifecycleService,
    private readonly taskRequestRouting: TaskRequestRoutingService,
    private readonly observer: GitContextObserver = new GitContextObserver("git-context-engine"),
  ) {}

  async create(
    input: CreateTaskRunRequest,
  ): Promise<SelectedTaskRunResponse> {
    this.observer.emit({
      level: "info",
      event: "task_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      outcome: "started",
      data: {
        mode: "create",
        title: input.title,
        taskRequestDecision: "initial",
      },
    });
    const creation = await this.taskLifecycle.createSimpleTask({
      requestId: input.requestId + ":task",
      sessionId: input.sessionId,
      title: input.title,
      objective: input.objective,
      placement: input.placement,
      at: input.at,
    });
    this.observer.emit({
      level: "info",
      event: "task_repository_validated",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: creation.task.taskId,
      outcome: "succeeded",
      data: {
        workingDirectory: creation.task.workingPath,
        branch: creation.task.branch,
        taskHead: creation.task.head,
        newlyCreated: creation.created,
      },
    });
    return await this.selectSimple(input, creation.task, creation.created, {
      kind: "continue_active_request",
      requestId: "R-0001",
      reason: "Continue the initial request created with the task.",
    }, "initial");
  }

  async activate(
    input: ActivateTaskRunRequest,
  ): Promise<SelectedTaskRunResponse> {
    if (!/^T-\d{8}-\d{4}$/.test(input.taskId)) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Task-run activation supports only V1 T-* task repositories.",
        details: { taskId: input.taskId },
      });
    }
    if (!input.route) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "V1 task activation requires an explicit continue-or-create request decision.",
        details: { taskId: input.taskId },
      });
    }
    this.observer.emit({
      level: "info",
      event: "task_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      outcome: "started",
      data: {
        mode: "activate",
        taskRequestDecision: input.route.kind === "continue_active_request"
          ? "continue"
          : "create",
        taskRequestId: input.route.kind === "continue_active_request"
          ? input.route.requestId
          : undefined,
      },
    });
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
    this.observer.emit({
      level: "info",
      event: "task_repository_validated",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: response.task.taskId,
      outcome: "succeeded",
      data: {
        workingDirectory: response.task.workingPath,
        branch: response.task.branch,
        taskHead: response.task.head,
      },
    });
    return await this.selectSimple(
      input,
      response.task,
      false,
      input.route,
      input.route.kind === "continue_active_request" ? "continue" : "create",
    );
  }

  private async selectSimple(
    input: CreateTaskRunRequest | ActivateTaskRunRequest,
    task: TaskCatalogEntry,
    taskCreated: boolean,
    route: NonNullable<ActivateTaskRunRequest["route"]>,
    taskRequestDecision: "initial" | "continue" | "create",
  ): Promise<SelectedTaskRunResponse> {
    if (input.runId) this.assertBindableRun(input);
    const run = input.runId
      ? readRun(this.database, input.runId)!
      : this.sessionRuns.start({
          requestId: input.requestId + ":run",
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          trigger: input.trigger,
          workState: input.workState,
          at: input.at,
        }, input.at).run;
    const planned = await this.taskRequestRouting.plan({
      requestId: input.requestId + ":route",
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      runId: run.runId,
      taskId: task.taskId,
      expectedTaskHead: task.head,
      route,
      at: input.at,
    });
    const selectedRun = planned.run;
    const context = await this.taskRequestRouting.projectContext(
      selectedRun.runId,
      await this.taskLifecycle.readContext(task),
    );
    return {
      task,
      run: selectedRun,
      context,
      taskCreated,
      sessionRunBound: Boolean(input.runId),
      taskRequestDecision,
      taskRequestCreated: taskRequestDecision === "initial" ? true : planned.requestCreated,
    };
  }

  private assertBindableRun(input: CreateTaskRunRequest | ActivateTaskRunRequest): void {
    const existing = readRun(this.database, input.runId!);
    if (!existing
      || existing.sessionId !== input.sessionId
      || existing.conversationId !== input.conversationId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "The session run cannot be bound to this task for the conversation.",
        details: {
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          runId: input.runId,
        },
      });
    }
  }

}
