import type {
  CreateTaskRequest,
  CreateTaskResponse,
  GetTaskRequest,
  GetTaskResponse,
  MountTaskRequest,
  MountTaskResponse,
  SessionRef,
  TaskCatalogEntry,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { ensureTaskSubmodule } from "../git/task-submodule.js";
import {
  ensureCanonicalTaskRepository,
  verifyCanonicalTaskRepository,
} from "../git/task-repository.js";
import { readSession } from "../repositories/session-records.js";
import {
  allocateTaskMount,
  completeTaskMount,
  markTaskMountRecoveryRequired,
  readInitializingTaskMounts,
  readTaskMount,
} from "../repositories/task-mount-records.js";
import {
  activateTask,
  allocateTask,
  readInitializingTasks,
  readTaskCatalogEntry,
  readTaskInitialization,
} from "../repositories/task-records.js";

export interface TaskLifecycleServiceOptions {
  database: ContextDatabase;
  dataRoot: string;
  now: () => string;
}

export class TaskLifecycleService {
  private readonly database: ContextDatabase;
  private readonly dataRoot: string;
  private readonly now: () => string;

  constructor(options: TaskLifecycleServiceOptions) {
    this.database = options.database;
    this.dataRoot = options.dataRoot;
    this.now = options.now;
  }

  async createTask(
    input: CreateTaskRequest,
  ): Promise<CreateTaskResponse> {
    const normalized = normalizeTaskInput(input);
    type CreationRecord = { taskId: string; created: boolean } | CreateTaskResponse;
    const pending = beginRecoverableIdempotent<CreationRecord>({
      database: this.database,
      requestId: input.requestId,
      operation: "create_task",
      payload: input,
      now: input.at,
      execute: () => {
        const task = allocateTask(this.database, this.dataRoot, input, normalized);
        return { taskId: task.taskId, created: true };
      },
    });
    const taskId = "taskId" in pending.result
      ? pending.result.taskId
      : pending.result.task.taskId;
    if (pending.completed && "task" in pending.result) {
      return pending.result;
    }
    try {
      const task = await this.initializeTask(taskId, input.at);
      const result: CreateTaskResponse = {
        task,
        created: pending.result.created,
      };
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
    await verifyCanonicalTaskRepository(record);
    return { task };
  }

  async mountTask(
    input: MountTaskRequest,
    session: SessionRef,
  ): Promise<MountTaskResponse> {
    validateTaskId(input.taskId);
    const task = this.requireActiveTask(input.taskId);
    verifyExpectedTaskHead(task, input.expectedTaskHead);
    const taskRecord = readTaskInitialization(this.database, input.taskId);
    if (!taskRecord) {
      throw taskNotFound(input.taskId);
    }
    await verifyCanonicalTaskRepository(taskRecord);

    type MountOperation = {
      sessionId: string;
      taskId: string;
      created: boolean;
    } | MountTaskResponse;
    const pending = beginRecoverableIdempotent<MountOperation>({
      database: this.database,
      requestId: input.requestId,
      operation: "mount_task",
      payload: input,
      now: input.at,
      execute: () => {
        const allocation = allocateTaskMount(this.database, session, task, input.at);
        return {
          sessionId: session.sessionId,
          taskId: task.taskId,
          created: allocation.created,
        };
      },
    });
    if (pending.completed && "mount" in pending.result) {
      return pending.result;
    }
    const created = pending.result.created;
    const sessionId = "sessionId" in pending.result
      ? pending.result.sessionId
      : pending.result.mount.sessionId;
    const taskId = "taskId" in pending.result
      ? pending.result.taskId
      : pending.result.mount.taskId;
    try {
      const mountRecord = readTaskMount(this.database, sessionId, taskId);
      if (!mountRecord) {
        throw new Error("Task mount operation has no SQLite record.");
      }
      const mountedHead = await ensureTaskSubmodule({
        session,
        task,
        mount: mountRecord,
      });
      const mount = completeTaskMount(
        this.database,
        sessionId,
        taskId,
        mountedHead,
        input.at,
      );
      const result: MountTaskResponse = { mount, created };
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markTaskMountRecoveryRequired(
        this.database,
        sessionId,
        taskId,
        message,
        input.at,
      );
      markRecoverableIdempotencyFailed({
        database: this.database,
        requestId: input.requestId,
      });
      throw error;
    }
  }

  async recoverInitializingState(): Promise<void> {
    for (const task of readInitializingTasks(this.database)) {
      const head = await ensureCanonicalTaskRepository({
        task,
        dataRoot: this.dataRoot,
      });
      activateTask(this.database, task.taskId, head, this.now());
    }
    for (const mount of readInitializingTaskMounts(this.database)) {
      const session = readSession(this.database, mount.sessionId);
      const task = readTaskCatalogEntry(this.database, mount.taskId);
      if (!session || !task) {
        markTaskMountRecoveryRequired(
          this.database,
          mount.sessionId,
          mount.taskId,
          "Mount references a missing session or active task.",
          this.now(),
        );
        continue;
      }
      try {
        const taskRecord = readTaskInitialization(this.database, task.taskId);
        if (!taskRecord) {
          throw taskNotFound(task.taskId);
        }
        await verifyCanonicalTaskRepository(taskRecord);
        const mountedHead = await ensureTaskSubmodule({ session, task, mount });
        completeTaskMount(
          this.database,
          mount.sessionId,
          mount.taskId,
          mountedHead,
          this.now(),
        );
      } catch (error) {
        markTaskMountRecoveryRequired(
          this.database,
          mount.sessionId,
          mount.taskId,
          error instanceof Error ? error.message : String(error),
          this.now(),
        );
        throw error;
      }
    }
  }

  private async initializeTask(taskId: string, at: string): Promise<TaskCatalogEntry> {
    const record = readTaskInitialization(this.database, taskId);
    if (!record) {
      throw taskNotFound(taskId);
    }
    if (record.status !== "initializing") {
      await verifyCanonicalTaskRepository(record);
      return this.requireActiveTask(taskId);
    }
    const head = await ensureCanonicalTaskRepository({
      task: record,
      dataRoot: this.dataRoot,
    });
    return activateTask(this.database, taskId, head, at);
  }

  private requireActiveTask(taskId: string): TaskCatalogEntry {
    const task = readTaskCatalogEntry(this.database, taskId);
    if (!task || task.status !== "active") {
      throw taskNotFound(taskId);
    }
    return task;
  }
}

function normalizeTaskInput(input: CreateTaskRequest): {
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
  if (!/^W-\d{8}-\d{4}$/.test(taskId)) {
    throw taskNotFound(taskId);
  }
}

function verifyExpectedTaskHead(
  task: TaskCatalogEntry,
  expectedHead: string | undefined,
): void {
  if (expectedHead && expectedHead !== task.head) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Task HEAD does not match the caller expectation.",
      retryable: true,
      details: {
        taskId: task.taskId,
        expectedHead,
        actualHead: task.head,
      },
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
