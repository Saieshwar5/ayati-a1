import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CreateTaskRequest,
  TaskCatalogEntry,
  TaskRef,
  TaskRepositoryLayout,
  TaskStatus,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { taskDirectoryName } from "../tasks/task-repository-layout.js";

interface TaskRow {
  task_id: string;
  layout_version: TaskRepositoryLayout;
  repository_path: string;
  working_path: string;
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
  layoutVersion: TaskRepositoryLayout;
  repositoryPath: string;
  workingPath: string;
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
  workspaceRoot: string = join(dataRoot, "workspace"),
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
  const workingPath = input.placement.mode === "requested"
    ? resolveTaskWorkingDirectory(workspaceRoot, input.placement.workingDirectory)
    : join(workspaceRoot, "tasks", taskId + "-" + taskSlug(normalized.title));
  const owner = findOverlappingTaskRoot(database, workingPath);
  if (owner) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "The requested working directory overlaps an existing task root.",
      details: {
        workingDirectory: workingPath,
        taskId: owner.task_id,
        existingWorkingDirectory: owner.working_path,
      },
    });
  }
  database.prepare([
    "INSERT INTO tasks(",
    "task_id, layout_version, repository_path, working_path, durable_branch, head_sha, title_cache, objective_cache,",
    "status, created_session_id, created_at, updated_at",
    ") VALUES (?, 'legacy_independent_v0', ?, ?, 'main', NULL, ?, ?, 'initializing', ?, ?, ?)",
  ].join(" ")).run(
    taskId,
    repositoryPath,
    workingPath,
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

export function allocateSimpleTask(
  database: ContextDatabase,
  taskRoot: string,
  input: CreateTaskRequest,
  normalized: { title: string; objective: string },
): TaskInitializationRecord {
  if (input.placement.mode !== "managed") {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "V1 task repositories must use managed placement under the configured task root.",
    });
  }
  const datePart = input.sessionId.match(/^S-(\d{8})-/)?.[1]
    ?? input.at.slice(0, 10).replaceAll("-", "");
  const prefix = "T-" + datePart + "-";
  const row = database.prepare([
    "SELECT COALESCE(MAX(CAST(substr(task_id, 12) AS INTEGER)), 0) + 1 AS next",
    "FROM tasks WHERE task_id LIKE ?",
  ].join(" ")).get(prefix + "%") as { next: number };
  const taskId = prefix + String(Number(row.next)).padStart(4, "0");
  const repositoryPath = join(taskRoot, taskDirectoryName(taskId, normalized.title));
  const owner = findOverlappingTaskRoot(database, repositoryPath);
  if (owner) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "The allocated V1 task directory overlaps an existing task root.",
      details: {
        repositoryPath,
        taskId: owner.task_id,
        existingWorkingDirectory: owner.working_path,
      },
    });
  }
  database.prepare([
    "INSERT INTO tasks(",
    "task_id, layout_version, repository_path, working_path, durable_branch, head_sha,",
    "title_cache, objective_cache, status, created_session_id, created_at, updated_at",
    ") VALUES (?, 'simple_repository_v1', ?, ?, 'main', NULL, ?, ?, 'initializing', ?, ?, ?)",
  ].join(" ")).run(
    taskId,
    repositoryPath,
    repositoryPath,
    normalized.title,
    normalized.objective,
    input.sessionId,
    input.at,
    input.at,
  );
  const task = readTaskInitialization(database, taskId);
  if (!task) {
    throw new Error("Allocated V1 task could not be read: " + taskId);
  }
  return task;
}

function findOverlappingTaskRoot(
  database: ContextDatabase,
  workingPath: string,
): { task_id: string; working_path: string } | undefined {
  const tasks = database.prepare(
    "SELECT task_id, working_path FROM tasks WHERE working_path IS NOT NULL",
  ).all() as unknown as Array<{ task_id: string; working_path: string }>;
  return tasks.find((task) => pathsOverlap(workingPath, task.working_path));
}

function pathsOverlap(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return isWithinPath(resolvedLeft, resolvedRight)
    || isWithinPath(resolvedRight, resolvedLeft);
}

function isWithinPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
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

export function readTaskCatalogEntries(
  database: ContextDatabase,
  input: { query?: string; limit: number },
): TaskCatalogEntry[] {
  const query = input.query?.trim().toLowerCase();
  const rows = query
    ? database.prepare([
        taskSelect(),
        "WHERE status = 'active' AND (lower(title_cache) LIKE ? OR lower(objective_cache) LIKE ? OR lower(working_path) LIKE ?)",
        "ORDER BY updated_at DESC, task_id DESC LIMIT ?",
      ].join(" ")).all("%" + query + "%", "%" + query + "%", "%" + query + "%", input.limit)
    : database.prepare([
        taskSelect(),
        "WHERE status = 'active' ORDER BY updated_at DESC, task_id DESC LIMIT ?",
      ].join(" ")).all(input.limit);
  return (rows as unknown as TaskRow[])
    .filter((row) => Boolean(row.head_sha))
    .map(catalogEntry);
}

export function updateTaskHead(
  database: ContextDatabase,
  taskId: string,
  expectedHead: string,
  head: string,
  at: string,
): TaskCatalogEntry {
  const result = database.prepare([
    "UPDATE tasks SET head_sha = ?, updated_at = ?",
    "WHERE task_id = ? AND head_sha = ? AND status = 'active'",
  ].join(" ")).run(head, at, taskId, expectedHead);
  const task = readTaskCatalogEntry(database, taskId);
  if (Number(result.changes) !== 1 || !task) {
    throw new Error("Task HEAD changed while checkpointing: " + taskId);
  }
  return task;
}

function readTaskRow(database: ContextDatabase, taskId: string): TaskRow | undefined {
  return database.prepare([
    taskSelect(),
    "WHERE task_id = ?",
  ].join(" ")).get(taskId) as TaskRow | undefined;
}

function taskSelect(): string {
  return [
    "SELECT task_id, layout_version, repository_path, durable_branch, head_sha, title_cache,",
    "working_path, objective_cache, status, created_session_id, created_at, updated_at FROM tasks",
  ].join(" ");
}

function initializationRecord(row: TaskRow): TaskInitializationRecord {
  return {
    taskId: row.task_id,
    layoutVersion: row.layout_version,
    repositoryPath: row.repository_path,
    workingPath: row.working_path,
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
    layoutVersion: row.layout_version,
    repositoryPath: row.repository_path,
    workingPath: row.working_path,
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

export function resolveTaskWorkingDirectory(workspaceRoot: string, value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const workspaceRelative = normalized.replace(/^(?:workspace|work_space)\//, "");
  const result = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(workspaceRoot, workspaceRelative);
  if (result === resolve(workspaceRoot)) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "A task must use a bounded directory inside or outside the workspace, not the workspace root itself.",
    });
  }
  return result;
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
