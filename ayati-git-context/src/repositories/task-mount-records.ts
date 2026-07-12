import { join } from "node:path";
import type {
  SessionRef,
  TaskCatalogEntry,
  TaskMountRef,
  TaskMountStatus,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface TaskMountRow {
  session_id: string;
  task_id: string;
  checkout_path: string;
  canonical_repository: string;
  branch: string;
  mounted_head: string | null;
  status: TaskMountStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface TaskMountRecord {
  sessionId: string;
  taskId: string;
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  mountedHead: string | null;
  status: TaskMountStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface TaskMountAllocation {
  mount: TaskMountRecord;
  created: boolean;
}

export function allocateTaskMount(
  database: ContextDatabase,
  session: SessionRef,
  task: TaskCatalogEntry,
  at: string,
): TaskMountAllocation {
  const existing = readTaskMount(database, session.sessionId, task.taskId);
  if (existing) {
    if (existing.status === "removed") {
      database.prepare([
        "UPDATE session_task_mounts",
        "SET status = 'initializing', mounted_head = NULL, updated_at = ?, last_error = NULL",
        "WHERE session_id = ? AND task_id = ?",
      ].join(" ")).run(at, session.sessionId, task.taskId);
      const restored = readTaskMount(database, session.sessionId, task.taskId);
      if (!restored) {
        throw new Error("Restored task mount could not be read.");
      }
      return { mount: restored, created: false };
    }
    return { mount: existing, created: false };
  }
  const checkoutPath = join(session.repositoryPath, "tasks", task.taskId);
  database.prepare([
    "INSERT INTO session_task_mounts(",
    "session_id, task_id, checkout_path, canonical_repository, branch, mounted_head,",
    "status, created_at, updated_at, last_error",
    ") VALUES (?, ?, ?, ?, ?, NULL, 'initializing', ?, ?, NULL)",
  ].join(" ")).run(
    session.sessionId,
    task.taskId,
    checkoutPath,
    task.repositoryPath,
    task.branch,
    at,
    at,
  );
  const mount = readTaskMount(database, session.sessionId, task.taskId);
  if (!mount) {
    throw new Error("Allocated task mount could not be read.");
  }
  return { mount, created: true };
}

export function readTaskMount(
  database: ContextDatabase,
  sessionId: string,
  taskId: string,
): TaskMountRecord | undefined {
  const row = database.prepare([
    mountSelect(),
    "WHERE session_id = ? AND task_id = ?",
  ].join(" ")).get(sessionId, taskId) as TaskMountRow | undefined;
  return row ? taskMountRecord(row) : undefined;
}

export function readInitializingTaskMounts(
  database: ContextDatabase,
): TaskMountRecord[] {
  const rows = database.prepare([
    mountSelect(),
    "WHERE status = 'initializing' ORDER BY created_at, session_id, task_id",
  ].join(" ")).all() as unknown as TaskMountRow[];
  return rows.map(taskMountRecord);
}

export function completeTaskMount(
  database: ContextDatabase,
  sessionId: string,
  taskId: string,
  mountedHead: string,
  at: string,
): TaskMountRef {
  database.prepare([
    "UPDATE session_task_mounts",
    "SET mounted_head = ?, status = 'ready', updated_at = ?, last_error = NULL",
    "WHERE session_id = ? AND task_id = ?",
  ].join(" ")).run(mountedHead, at, sessionId, taskId);
  const record = readTaskMount(database, sessionId, taskId);
  if (!record || !record.mountedHead) {
    throw new Error("Completed task mount could not be read.");
  }
  return taskMountRef(record);
}

export function updateTaskMountHead(
  database: ContextDatabase,
  sessionId: string,
  taskId: string,
  expectedHead: string,
  head: string,
  at: string,
): TaskMountRef {
  const result = database.prepare([
    "UPDATE session_task_mounts SET mounted_head = ?, updated_at = ?, last_error = NULL",
    "WHERE session_id = ? AND task_id = ? AND mounted_head = ? AND status = 'ready'",
  ].join(" ")).run(head, at, sessionId, taskId, expectedHead);
  const record = readTaskMount(database, sessionId, taskId);
  if (Number(result.changes) !== 1 || !record) {
    throw new Error("Task mount HEAD changed while checkpointing: " + taskId);
  }
  return taskMountRef(record);
}

export function markTaskMountRecoveryRequired(
  database: ContextDatabase,
  sessionId: string,
  taskId: string,
  error: string,
  at: string,
): void {
  database.prepare([
    "UPDATE session_task_mounts",
    "SET status = 'recovery_required', updated_at = ?, last_error = ?",
    "WHERE session_id = ? AND task_id = ?",
  ].join(" ")).run(at, error, sessionId, taskId);
}

export function taskMountRef(record: TaskMountRecord): TaskMountRef {
  if (!record.mountedHead) {
    throw new Error("Task mount has no mounted HEAD: " + record.taskId);
  }
  return {
    sessionId: record.sessionId,
    taskId: record.taskId,
    checkoutPath: record.checkoutPath,
    canonicalRepository: record.canonicalRepository,
    branch: record.branch,
    mountedHead: record.mountedHead,
    status: record.status,
  };
}

function mountSelect(): string {
  return [
    "SELECT session_id, task_id, checkout_path, canonical_repository, branch,",
    "mounted_head, status, created_at, updated_at, last_error FROM session_task_mounts",
  ].join(" ");
}

function taskMountRecord(row: TaskMountRow): TaskMountRecord {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    checkoutPath: row.checkout_path,
    canonicalRepository: row.canonical_repository,
    branch: row.branch,
    mountedHead: row.mounted_head,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}
