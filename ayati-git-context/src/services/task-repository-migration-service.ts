import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  InventoryTaskMigrationsRequest,
  InventoryTaskMigrationsResponse,
  MigrateTaskRepositoryRequest,
  MigrateTaskRepositoryResponse,
  TaskMigrationInventory,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import { configureAyatiGitIdentity, gitCommitEnvironment, runGit, runGitRaw } from "../git/git-process.js";
import {
  completeTaskRepositoryMigration,
  readAllTaskInitializations,
  readTaskCatalogEntry,
  readTaskInitialization,
} from "../repositories/task-records.js";
import { readLegacyTaskContext } from "../tasks/legacy-task-context-reader.js";
import { renderTaskCard } from "../tasks/task-card.js";
import { renderTaskMigrationCommit, parseSimpleTaskCommit } from "../tasks/task-commit-metadata.js";
import {
  requestPath,
  TASK_CARD_PATH,
  TASK_INBOX_KEEP_PATH,
  TASK_REFERENCES_PATH,
} from "../tasks/task-repository-layout.js";
import { renderTaskReferences } from "../tasks/task-references.js";
import { renderTaskRequest, type TaskRequestStatus } from "../tasks/task-request.js";

const INITIAL_REQUEST_ID = "R-0001";

export class TaskRepositoryMigrationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    taskRoot: string;
  }) {}

  async inventory(input: InventoryTaskMigrationsRequest): Promise<InventoryTaskMigrationsResponse> {
    const tasks = readAllTaskInitializations(this.options.database)
      .filter((task) => !input.taskId || task.taskId === input.taskId);
    return { tasks: await Promise.all(tasks.map((task) => this.inspect(task.taskId))) };
  }

  async migrate(input: MigrateTaskRepositoryRequest): Promise<MigrateTaskRepositoryResponse> {
    const task = readTaskInitialization(this.options.database, input.taskId);
    if (!task?.head) throw notFound(input.taskId);
    if (task.layoutVersion === "simple_repository_v1") {
      const metadata = migrationMetadata(this.options.database, input.taskId);
      if (!metadata?.migration_commit || !metadata.legacy_repository_path) {
        throw invalid("Task is already V1 and has no legacy migration boundary.", input.taskId);
      }
      return {
        task: readTaskCatalogEntry(this.options.database, input.taskId)!,
        migrated: false,
        baseHead: metadata.migrated_from_head ?? input.expectedTaskHead,
        migrationCommit: metadata.migration_commit,
        legacyRepositoryPath: metadata.legacy_repository_path,
      };
    }
    if (task.head !== input.expectedTaskHead) throw headMismatch(input, task.head);

    const recoverableHead = await recognizeMigrationCommit(task.workingPath, input.taskId, input.expectedTaskHead);
    if (recoverableHead) {
      return this.acknowledge(input, task.repositoryPath, recoverableHead);
    }
    const inventory = await this.inspect(input.taskId);
    if (inventory.cohort !== "managed_clean") {
      blockMigration(this.options.database, input.taskId, inventory.blockers, input.at);
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Legacy task is not safe for automatic migration.",
        details: { taskId: input.taskId, cohort: inventory.cohort, blockers: inventory.blockers },
      });
    }
    acquireMigrationIntent(this.options.database, input, task.repositoryPath, task.workingPath);
    try {
      const context = await readLegacyTaskContext(readTaskCatalogEntry(this.options.database, input.taskId)!, task.workingPath);
      const status = legacyStatus(context.taskStatus);
      const requestStatus: TaskRequestStatus = status === "done" ? "done" : status === "blocked" ? "blocked" : "active";
      const currentRequest = requestStatus === "active" ? INITIAL_REQUEST_ID : null;
      const importantPaths = context.importantPaths.slice(0, 20).map((path) => ({ path }));
      const requestFile = requestPath(INITIAL_REQUEST_ID, context.title);
      const writes = new Map<string, string>([
        [TASK_CARD_PATH, renderTaskCard({
          schema: "ayati.task/v1",
          id: input.taskId,
          title: context.title,
          status: status === "done" ? "paused" : "active",
          currentRequest,
          purpose: context.objective,
          currentSnapshot: context.summary,
          currentFocus: status === "done"
            ? "Choose or create the next request."
            : status === "blocked"
              ? context.next ?? "Resolve the migrated legacy blocker."
              : context.next ?? "Continue the migrated legacy objective.",
          blockers: status === "blocked" ? [context.summary] : [],
          importantPaths,
          workingAgreements: [
            "Keep durable context and verified outcomes in Git.",
            "Git records external outcomes but does not own or undo external state.",
            "Keep secrets and local attachment bytes out of Git.",
          ],
        })],
        [requestFile, renderTaskRequest({
          schema: "ayati.request/v1",
          id: INITIAL_REQUEST_ID,
          title: context.title,
          status: requestStatus,
          createdAt: task.createdAt,
          source: "imported",
          request: context.objective,
          acceptance: ["Continue or verify the imported legacy objective without inventing new requirements."],
          constraints: [],
          outcome: requestStatus === "active" ? "Imported from legacy history; work remains active." : context.summary,
        })],
        [TASK_REFERENCES_PATH, renderTaskReferences([])],
        [TASK_INBOX_KEEP_PATH, ""],
      ]);
      const gitignore = await readFile(resolve(task.workingPath, ".gitignore"), "utf8").catch(() => "");
      writes.set(".gitignore", withInboxIgnore(gitignore));
      for (const [path, content] of writes) {
        await writeFileAtomically(resolve(task.workingPath, path), content);
      }
      await configureAyatiGitIdentity(task.workingPath);
      const paths = [...writes.keys()].sort();
      await runGit(["add", "--", ...paths], { cwd: task.workingPath });
      await runGit(["commit", "-m", renderTaskMigrationCommit({
        subject: "migrate task context to repository v1",
        taskId: input.taskId,
        requestId: INITIAL_REQUEST_ID,
      })], { cwd: task.workingPath, env: gitCommitEnvironment(input.at) });
      const migrationCommit = await runGit(["rev-parse", "HEAD"], { cwd: task.workingPath });
      recordMigrationCommit(this.options.database, input.taskId, migrationCommit, input.at);
      return this.acknowledge(input, task.repositoryPath, migrationCommit);
    } catch (error) {
      recordMigrationError(this.options.database, input.taskId, error, input.at);
      throw error;
    }
  }

  private acknowledge(
    input: MigrateTaskRepositoryRequest,
    legacyRepositoryPath: string,
    migrationCommit: string,
  ): MigrateTaskRepositoryResponse {
    const task = this.options.database.transaction(() => {
      const updated = completeTaskRepositoryMigration(this.options.database, {
        taskId: input.taskId,
        expectedHead: input.expectedTaskHead,
        repositoryPath: readTaskInitialization(this.options.database, input.taskId)!.workingPath,
        migrationCommit,
        legacyRepositoryPath,
        at: input.at,
      });
      this.options.database.prepare([
        "UPDATE task_repository_migrations SET phase = 'completed', migration_commit = ?, updated_at = ?, last_error = NULL",
        "WHERE task_id = ?",
      ].join(" ")).run(migrationCommit, input.at, input.taskId);
      return updated;
    });
    return {
      task,
      migrated: true,
      baseHead: input.expectedTaskHead,
      migrationCommit,
      legacyRepositoryPath,
    };
  }

  private async inspect(taskId: string): Promise<TaskMigrationInventory> {
    const task = readTaskInitialization(this.options.database, taskId);
    if (!task?.head) throw notFound(taskId);
    const migrationStatus = migrationMetadata(this.options.database, taskId)?.migration_status
      ?? (task.layoutVersion === "simple_repository_v1" ? "not_required" : "pending");
    const base: Omit<TaskMigrationInventory, "cohort" | "dirtyPaths" | "blockers"> = {
      taskId,
      layoutVersion: task.layoutVersion,
      migrationStatus,
      catalogHead: task.head,
      workingPath: task.workingPath,
      ...(task.layoutVersion === "legacy_independent_v0" ? { legacyRepositoryPath: task.repositoryPath } : {}),
    };
    if (task.layoutVersion === "simple_repository_v1") {
      return { ...base, cohort: "already_v1", dirtyPaths: [], blockers: [] };
    }
    if (!isInside(this.options.taskRoot, task.workingPath)) {
      return { ...base, cohort: "external_path", dirtyPaths: [], blockers: ["Working checkout is outside the managed task root."] };
    }
    if (isTaskBusy(this.options.database, taskId)) {
      return { ...base, cohort: "busy", dirtyPaths: [], blockers: ["Task has an active run, authority, or finalization."] };
    }
    const stat = await lstat(task.workingPath).catch(() => undefined);
    if (!stat) return { ...base, cohort: "missing_checkout", dirtyPaths: [], blockers: ["Working checkout is missing."] };
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ...base, cohort: "invalid", dirtyPaths: [], blockers: ["Working checkout is not a normal directory."] };
    }
    try {
      const [workingHead, legacyHead, branch, topLevel, status, descriptor] = await Promise.all([
        runGit(["rev-parse", "HEAD"], { cwd: task.workingPath }),
        runGit(["rev-parse", "refs/heads/" + task.branch], { cwd: task.repositoryPath }),
        runGit(["symbolic-ref", "--short", "HEAD"], { cwd: task.workingPath }),
        runGit(["rev-parse", "--show-toplevel"], { cwd: task.workingPath }),
        runGitRaw(["status", "--porcelain", "--untracked-files=all"], { cwd: task.workingPath }),
        runGit(["show", "HEAD:.ayati/task.md"], { cwd: task.workingPath }),
      ]);
      const dirtyPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3));
      const identityValid = descriptor.split(/\r?\n/).filter((line) => line.startsWith("Task: "))
        .some((line) => line === "Task: " + taskId);
      const detailed = { ...base, workingHead, legacyHead, dirtyPaths };
      if (!identityValid || resolve(topLevel) !== resolve(task.workingPath) || branch !== task.branch) {
        return { ...detailed, cohort: "invalid", blockers: ["Checkout identity, branch, or task descriptor is invalid."] };
      }
      if (dirtyPaths.length > 0) return { ...detailed, cohort: "dirty", blockers: ["Working checkout has uncommitted changes."] };
      if (workingHead !== task.head || legacyHead !== task.head) {
        return { ...detailed, cohort: "diverged", blockers: ["Catalog, working checkout, and legacy bare HEADs do not agree."] };
      }
      return { ...detailed, cohort: "managed_clean", blockers: [] };
    } catch (error) {
      return {
        ...base,
        cohort: "invalid",
        dirtyPaths: [],
        blockers: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function legacyStatus(value: string | undefined): "in_progress" | "done" | "blocked" {
  return value === "done" || value === "blocked" ? value : "in_progress";
}

function withInboxIgnore(value: string): string {
  const lines = value.replaceAll("\r\n", "\n").split("\n").filter((line) => line.length > 0);
  for (const line of [".ayati/inbox/*", "!.ayati/inbox/.gitkeep"]) {
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.join("\n") + "\n";
}

function isTaskBusy(database: ContextDatabase, taskId: string): boolean {
  const run = database.prepare("SELECT 1 AS found FROM runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(taskId);
  const authority = database.prepare([
    "SELECT 1 AS found FROM task_mutation_authorities WHERE task_id = ?",
    "AND status IN ('active', 'verified', 'recovery_required') LIMIT 1",
  ].join(" ")).get(taskId);
  const finalization = database.prepare([
    "SELECT 1 AS found FROM task_run_finalizations WHERE task_id = ?",
    "AND phase NOT IN ('completed') LIMIT 1",
  ].join(" ")).get(taskId);
  return Boolean(run || authority || finalization);
}

function acquireMigrationIntent(
  database: ContextDatabase,
  input: MigrateTaskRepositoryRequest,
  legacyRepositoryPath: string,
  workingPath: string,
): void {
  database.transaction(() => {
    const existing = database.prepare("SELECT request_id, base_head FROM task_repository_migrations WHERE task_id = ?")
      .get(input.taskId) as { request_id: string; base_head: string } | undefined;
    if (existing && (existing.request_id !== input.requestId || existing.base_head !== input.expectedTaskHead)) {
      throw invalid("Task already has a different migration intent.", input.taskId);
    }
    if (!existing) {
      database.prepare([
        "INSERT INTO task_repository_migrations(task_id, request_id, phase, legacy_repository_path, working_path, base_head, created_at, updated_at)",
        "VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?)",
      ].join(" ")).run(input.taskId, input.requestId, legacyRepositoryPath, workingPath, input.expectedTaskHead, input.at, input.at);
    }
    database.prepare("UPDATE tasks SET migration_status = 'in_progress', updated_at = ? WHERE task_id = ?")
      .run(input.at, input.taskId);
  });
}

function recordMigrationCommit(database: ContextDatabase, taskId: string, head: string, at: string): void {
  database.prepare([
    "UPDATE task_repository_migrations SET phase = 'committed', migration_commit = ?, updated_at = ?, last_error = NULL",
    "WHERE task_id = ?",
  ].join(" ")).run(head, at, taskId);
}

function recordMigrationError(database: ContextDatabase, taskId: string, error: unknown, at: string): void {
  database.prepare([
    "UPDATE task_repository_migrations SET phase = 'blocked', last_error = ?, updated_at = ? WHERE task_id = ?",
  ].join(" ")).run(error instanceof Error ? error.message : String(error), at, taskId);
  database.prepare("UPDATE tasks SET migration_status = 'blocked', updated_at = ? WHERE task_id = ?")
    .run(at, taskId);
}

function blockMigration(database: ContextDatabase, taskId: string, blockers: string[], at: string): void {
  database.prepare("UPDATE tasks SET migration_status = 'blocked', updated_at = ? WHERE task_id = ?")
    .run(at, taskId);
  void blockers;
}

async function recognizeMigrationCommit(
  workingPath: string,
  taskId: string,
  baseHead: string,
): Promise<string | undefined> {
  try {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: workingPath });
    const parent = await runGit(["rev-parse", "HEAD^"], { cwd: workingPath });
    const message = await runGitRaw(["log", "-1", "--format=%B"], { cwd: workingPath });
    const metadata = parseSimpleTaskCommit(message);
    return parent === baseHead && metadata?.event === "task_repository_migrated"
      && metadata.taskId === taskId ? head : undefined;
  } catch {
    return undefined;
  }
}

function migrationMetadata(database: ContextDatabase, taskId: string): {
  migration_status: TaskMigrationInventory["migrationStatus"];
  legacy_repository_path: string | null;
  migrated_from_head: string | null;
  migration_commit: string | null;
} | undefined {
  return database.prepare([
    "SELECT migration_status, legacy_repository_path, migrated_from_head, migration_commit",
    "FROM tasks WHERE task_id = ?",
  ].join(" ")).get(taskId) as {
    migration_status: TaskMigrationInventory["migrationStatus"];
    legacy_repository_path: string | null;
    migrated_from_head: string | null;
    migration_commit: string | null;
  } | undefined;
}

function headMismatch(input: MigrateTaskRepositoryRequest, actualHead: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_HEAD_MISMATCH",
    message: "Task changed after migration inventory.",
    retryable: true,
    details: { taskId: input.taskId, expectedHead: input.expectedTaskHead, actualHead },
  });
}

function invalid(message: string, taskId: string): GitContextServiceError {
  return new GitContextServiceError({ code: "INVALID_REQUEST", message, details: { taskId } });
}

function notFound(taskId: string): GitContextServiceError {
  return new GitContextServiceError({ code: "NOT_FOUND", message: "Task does not exist.", details: { taskId } });
}
