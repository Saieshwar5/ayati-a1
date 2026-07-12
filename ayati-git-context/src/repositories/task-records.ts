import { join } from "node:path";
import type {
  CreateTaskRequest,
  TaskCatalogEntry,
  TaskRef,
  TaskStatus,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

interface TaskRow {
  task_id: string;
  repository_path: string;
  durable_branch: string;
  head_sha: string | null;
  title_cache: string;
  objective_cache: string;
  status: TaskStatus;
  created_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface TaskInitializationRecord {
  taskId: string;
  repositoryPath: string;
  branch: string;
  head: string | null;
  title: string;
  objective: string;
  status: TaskStatus;
  createdSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export function allocateTask(
  database: ContextDatabase,
  dataRoot: string,
  input: CreateTaskRequest,
  normalized: { title: string; objective: string },
): TaskInitializationRecord {
  const datePart = input.sessionId.match(/^S-(\d{8})-/)?.[1]
    ?? input.at.slice(0, 10).replaceAll("-", "");
  const prefix = "W-" + datePart + "-";
  const row = database.prepare([
    "SELECT COALESCE(MAX(CAST(substr(task_id, 12) AS INTEGER)), 0) + 1 AS next",
    "FROM tasks WHERE task_id LIKE ?",
  ].join(" ")).get(prefix + "%") as { next: number };
  const taskId = prefix + String(Number(row.next)).padStart(4, "0");
  const repositoryPath = join(
    dataRoot,
    "tasks",
    taskId + "-" + taskSlug(normalized.title) + ".git",
  );
  database.prepare([
    "INSERT INTO tasks(",
    "task_id, repository_path, durable_branch, head_sha, title_cache, objective_cache,",
    "status, created_session_id, created_at, updated_at",
    ") VALUES (?, ?, 'main', NULL, ?, ?, 'initializing', ?, ?, ?)",
  ].join(" ")).run(
    taskId,
    repositoryPath,
    normalized.title,
    normalized.objective,
    input.sessionId,
    input.at,
    input.at,
  );
  const task = readTaskInitialization(database, taskId);
  if (!task) {
    throw new Error("Allocated task could not be read: " + taskId);
  }
  return task;
}

export function readTaskInitialization(
  database: ContextDatabase,
  taskId: string,
): TaskInitializationRecord | undefined {
  const row = readTaskRow(database, taskId);
  return row ? initializationRecord(row) : undefined;
}

export function readInitializingTasks(
  database: ContextDatabase,
): TaskInitializationRecord[] {
  const rows = database.prepare([
    taskSelect(),
    "WHERE status = 'initializing' ORDER BY created_at, task_id",
  ].join(" ")).all() as unknown as TaskRow[];
  return rows.map(initializationRecord);
}

export function activateTask(
  database: ContextDatabase,
  taskId: string,
  head: string,
  at: string,
): TaskCatalogEntry {
  database.prepare([
    "UPDATE tasks SET head_sha = ?, status = 'active', updated_at = ?",
    "WHERE task_id = ? AND status = 'initializing'",
  ].join(" ")).run(head, at, taskId);
  const row = readTaskRow(database, taskId);
  if (!row) {
    throw new Error("Activated task could not be read: " + taskId);
  }
  return catalogEntry(row);
}

export function readTaskCatalogEntry(
  database: ContextDatabase,
  taskId: string,
): TaskCatalogEntry | undefined {
  const row = readTaskRow(database, taskId);
  if (!row || !row.head_sha) {
    return undefined;
  }
  return catalogEntry(row);
}

function readTaskRow(database: ContextDatabase, taskId: string): TaskRow | undefined {
  return database.prepare([
    taskSelect(),
    "WHERE task_id = ?",
  ].join(" ")).get(taskId) as TaskRow | undefined;
}

function taskSelect(): string {
  return [
    "SELECT task_id, repository_path, durable_branch, head_sha, title_cache,",
    "objective_cache, status, created_session_id, created_at, updated_at FROM tasks",
  ].join(" ");
}

function initializationRecord(row: TaskRow): TaskInitializationRecord {
  return {
    taskId: row.task_id,
    repositoryPath: row.repository_path,
    branch: row.durable_branch,
    head: row.head_sha,
    title: row.title_cache,
    objective: row.objective_cache,
    status: row.status,
    createdSessionId: row.created_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function catalogEntry(row: TaskRow): TaskCatalogEntry {
  if (!row.head_sha) {
    throw new Error("Active task is missing its Git HEAD: " + row.task_id);
  }
  const task: TaskRef = {
    taskId: row.task_id,
    repositoryPath: row.repository_path,
    branch: row.durable_branch,
    head: row.head_sha,
  };
  return {
    ...task,
    title: row.title_cache,
    objective: row.objective_cache,
    status: row.status,
    createdSessionId: row.created_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "task";
}
