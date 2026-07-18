import { join } from "node:path";
import type {
  GetTaskRequest,
  GetTaskResponse,
  GitContextRequestEnvelope,
  TaskCatalogEntry,
  TaskCandidate,
  TaskContextProjection,
  ListTasksRequest,
  ListTasksResponse,
  SessionId,
  TaskPlacement,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  activateTask,
  allocateSimpleTask,
  readInitializingTasks,
  readTaskCatalogEntry,
  readTaskCatalogEntries,
  readTaskInitialization,
  type TaskInitializationRecord,
} from "../repositories/task-records.js";
import { readTaskContext } from "../tasks/task-context-reader.js";
import {
  completeSimpleTaskCreation,
  ensureSimpleTaskRepository,
  type SimpleTaskCreationHook,
} from "../tasks/simple-task-repository-creator.js";

export interface TaskLifecycleServiceOptions {
  database: ContextDatabase;
  dataRoot: string;
  workspaceRoot: string;
  now: () => string;
  simpleTaskCreationHook?: SimpleTaskCreationHook;
}

export interface CreateSimpleTaskResult {
  task: TaskCatalogEntry;
  created: boolean;
}

export interface CreateSimpleTaskInput extends GitContextRequestEnvelope {
  sessionId: SessionId;
  title: string;
  objective: string;
  placement: TaskPlacement;
  at: string;
}

export class TaskLifecycleService {
  private readonly database: ContextDatabase;
  private readonly taskRoot: string;
  private readonly now: () => string;
  private readonly simpleTaskCreationHook?: SimpleTaskCreationHook;

  constructor(options: TaskLifecycleServiceOptions) {
    this.database = options.database;
    this.taskRoot = join(options.workspaceRoot, "tasks");
    this.now = options.now;
    this.simpleTaskCreationHook = options.simpleTaskCreationHook;
  }

  async createSimpleTask(input: CreateSimpleTaskInput): Promise<CreateSimpleTaskResult> {
    const normalized = normalizeTaskInput(input);
    validateSimpleTaskCreationInput(input);
    const recovering = hasRecoverableIdempotencyRequest({
      database: this.database,
      requestId: input.requestId,
      operation: "create_simple_task",
      payload: input,
    });
    type CreationRecord = { taskId: string; created: boolean } | CreateSimpleTaskResult;
    const pending = beginRecoverableIdempotent<CreationRecord>({
      database: this.database,
      requestId: input.requestId,
      operation: "create_simple_task",
      payload: input,
      now: input.at,
      execute: () => {
        const task = allocateSimpleTask(
          this.database,
          this.taskRoot,
          input,
          normalized,
        );
        return { taskId: task.taskId, created: true };
      },
    });
    const taskId = "taskId" in pending.result
      ? pending.result.taskId
      : pending.result.task.taskId;
    if (pending.completed && "task" in pending.result) return pending.result;
    try {
      const record = readTaskInitialization(this.database, taskId);
      if (!record) throw taskNotFound(taskId);
      await this.simpleTaskCreationHook?.("allocated", record);
      const task = await this.initializeSimpleTask(record, input.at, recovering);
      const result: CreateSimpleTaskResult = { task, created: pending.result.created };
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      markRecoverableIdempotencyFailed({
        database: this.database,
        requestId: input.requestId,
      });
      throw error;
    }
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    validateTaskId(input.taskId);
    const task = this.requireActiveTask(input.taskId);
    const record = readTaskInitialization(this.database, input.taskId);
    if (!record) {
      throw taskNotFound(input.taskId);
    }
    const context = await this.readContext(task);
    return {
      task: {
        ...task,
        repositoryPath: context.task.repositoryPath,
        workingPath: context.task.workingPath,
        branch: context.task.branch,
        head: context.task.head,
        title: context.title,
        objective: context.objective,
      },
      context,
    };
  }

  listTasks(input: ListTasksRequest): ListTasksResponse {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    return {
      tasks: readTaskCatalogEntries(this.database, {
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        limit,
      }).map((task) => ({
        taskId: task.taskId,
        title: task.title,
        objective: task.objective,
        status: task.status,
        head: task.head,
        workingDirectory: task.workingPath,
        updatedAt: task.updatedAt,
      })),
    };
  }

  async listRoutingCandidates(input: ListTasksRequest): Promise<TaskCandidate[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const tasks = readTaskCatalogEntries(this.database, {
      ...(input.query?.trim() ? { query: input.query.trim() } : {}),
      limit,
    });
    return await Promise.all(tasks.map(async (task): Promise<TaskCandidate> => {
      const base: TaskCandidate = {
        taskId: task.taskId,
        title: task.title,
        objective: task.objective,
        status: task.status,
        head: task.head,
        workingDirectory: task.workingPath,
        updatedAt: task.updatedAt,
      };
      try {
        const context = await this.readContext(task);
        return {
          ...base,
          title: context.title,
          objective: context.objective,
          lifecycleStatus: context.lifecycleStatus,
          repositoryHealth: context.repositoryHealth,
          ...(context.currentRequest
            ? {
                currentRequest: {
                  id: context.currentRequest.id,
                  title: context.currentRequest.title,
                  status: context.currentRequest.status,
                },
              }
            : {}),
        };
      } catch {
        return { ...base, repositoryHealth: "unavailable" };
      }
    }));
  }

  async recoverInitializingState(): Promise<void> {
    for (const task of readInitializingTasks(this.database)) {
      try {
        const head = await ensureSimpleTaskRepository({
          task,
          taskRoot: this.taskRoot,
          recovering: true,
        });
        activateTask(this.database, task.taskId, head, this.now());
        await completeSimpleTaskCreation(task);
      } catch {
        // One unusable user-requested directory must not prevent unrelated
        // sessions and tasks from recovering. Retrying the original request
        // re-enters the same idempotent initialization record.
      }
    }
  }

  private async initializeSimpleTask(
    record: TaskInitializationRecord,
    at: string,
    recovering: boolean,
  ): Promise<TaskCatalogEntry> {
    if (record.status !== "initializing") {
      await completeSimpleTaskCreation(record);
      const task = this.requireActiveTask(record.taskId);
      const context = await this.readContext(task);
      if (context.task.head !== task.head) {
        throw new GitContextServiceError({
          code: "TASK_HEAD_MISMATCH",
          message: "Recovered V1 task HEAD does not match its catalog entry.",
          details: { taskId: task.taskId, catalogHead: task.head, actualHead: context.task.head },
        });
      }
      return task;
    }
    const head = await ensureSimpleTaskRepository({
      task: record,
      taskRoot: this.taskRoot,
      recovering,
      ...(this.simpleTaskCreationHook ? { onPhase: this.simpleTaskCreationHook } : {}),
    });
    const task = activateTask(this.database, record.taskId, head, at);
    await this.simpleTaskCreationHook?.("catalog_activated", record);
    await completeSimpleTaskCreation(record);
    return task;
  }

  private requireActiveTask(taskId: string): TaskCatalogEntry {
    const task = readTaskCatalogEntry(this.database, taskId);
    if (!task || task.status !== "active") {
      throw taskNotFound(taskId);
    }
    return task;
  }

  async readContext(
    task: TaskCatalogEntry,
  ): Promise<TaskContextProjection> {
    return await readTaskContext(task, {
      taskRoot: this.taskRoot,
    });
  }
}

function normalizeTaskInput(input: CreateSimpleTaskInput): {
  title: string;
  objective: string;
} {
  const title = input.title.trim().replace(/\s+/g, " ");
  const objective = input.objective.trim().replace(/\s+/g, " ");
  if (title.length === 0 || title.length > 120) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Task title must contain between 1 and 120 characters.",
    });
  }
  if (objective.length === 0 || objective.length > 2_000) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Task objective must contain between 1 and 2000 characters.",
    });
  }
  return { title, objective };
}

function validateTaskId(taskId: string): void {
  if (!/^T-\d{8}-\d{4}$/.test(taskId)) {
    throw taskNotFound(taskId);
  }
}

function validateSimpleTaskCreationInput(input: CreateSimpleTaskInput): void {
  if (input.placement.mode !== "managed") {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "V1 task creation currently supports managed placement only.",
    });
  }
  if (!Number.isFinite(Date.parse(input.at))) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "V1 task creation time must be a valid timestamp.",
    });
  }
}

function taskNotFound(taskId: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_NOT_FOUND",
    message: "Task does not exist.",
    details: { taskId },
  });
}
