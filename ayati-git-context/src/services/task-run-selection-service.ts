import type {
  ActivateTaskRunRequest,
  CreateTaskRunRequest,
  SelectedTaskRunResponse,
  SessionRef,
  TaskCatalogEntry,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import {
  bindActiveRunToTask,
  readRun,
} from "../repositories/run-records.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import { readTaskContext } from "../tasks/task-context-reader.js";
import type { SessionRunLifecycleService } from "./session-run-lifecycle-service.js";
import { GitContextObserver } from "../observability.js";

export class TaskRunSelectionService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly taskLifecycle: TaskLifecycleService,
    private readonly sessionRuns: SessionRunLifecycleService,
    private readonly observer: GitContextObserver = new GitContextObserver("git-context-engine"),
  ) {}

  async create(
    input: CreateTaskRunRequest,
    session: SessionRef,
  ): Promise<SelectedTaskRunResponse> {
    this.observer.emit({
      level: "info",
      event: "task_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      outcome: "started",
      data: { mode: "create", title: input.title },
    });
    const creation = await this.taskLifecycle.createTask({
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
      data: { taskHead: creation.task.head, newlyCreated: creation.created },
    });
    return await this.select(input, session, creation.task, creation.created);
  }

  async activate(
    input: ActivateTaskRunRequest,
    session: SessionRef,
  ): Promise<SelectedTaskRunResponse> {
    this.observer.emit({
      level: "info",
      event: "task_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      outcome: "started",
      data: { mode: "activate" },
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
      data: { taskHead: response.task.head },
    });
    return await this.select(input, session, response.task, false);
  }

  private async select(
    input: CreateTaskRunRequest | ActivateTaskRunRequest,
    session: SessionRef,
    task: TaskCatalogEntry,
    taskCreated: boolean,
  ): Promise<SelectedTaskRunResponse> {
    const mounted = await this.taskLifecycle.mountTask({
      requestId: input.requestId + ":mount",
      sessionId: input.sessionId,
      taskId: task.taskId,
      expectedTaskHead: task.head,
      at: input.at,
    }, session);
    this.observer.emit({
      level: "info",
      event: "task_mounted",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: task.taskId,
      outcome: "succeeded",
      data: {
        created: mounted.created,
        mountedHead: mounted.mount.mountedHead,
        checkoutPath: mounted.mount.workingPath,
      },
    });
    if (input.runId) {
      const existing = readRun(this.database, input.runId);
      this.observer.emit({
        level: "info",
        event: "run_promotion_started",
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        runId: input.runId,
        taskId: task.taskId,
        outcome: "started",
        data: {
          fromClass: existing?.runClass ?? "unknown",
          toClass: "task",
          preservedRunId: true,
        },
      });
    }
    const run = input.runId
      ? this.promoteExistingRun(input, task.taskId)
      : bindActiveRunToTask(this.database, input.sessionId, this.sessionRuns.start({
          requestId: input.requestId + ":run",
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          trigger: input.trigger,
          workState: input.workState,
          at: input.at,
        }, input.at).run.runId, task.taskId);
    return {
      task,
      mount: mounted.mount,
      run,
      context: await readTaskContext(task, mounted.mount.workingPath),
      taskCreated,
      mountCreated: mounted.created,
      runPromoted: Boolean(input.runId),
    };
  }

  private promoteExistingRun(
    input: CreateTaskRunRequest | ActivateTaskRunRequest,
    taskId: string,
  ) {
    const existing = readRun(this.database, input.runId!);
    if (!existing
      || existing.sessionId !== input.sessionId
      || existing.conversationId !== input.conversationId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "The session run cannot be promoted for this conversation.",
        details: {
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          runId: input.runId,
        },
      });
    }
    return bindActiveRunToTask(this.database, input.sessionId, input.runId!, taskId);
  }
}
