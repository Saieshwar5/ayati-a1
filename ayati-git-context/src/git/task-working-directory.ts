import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GitContextServiceError } from "../errors.js";
import type { TaskInitializationRecord } from "../repositories/task-records.js";
import { configureAyatiGitIdentity, gitCommitEnvironment, runGit } from "./git-process.js";

export async function ensureTaskWorkingDirectory(
  task: TaskInitializationRecord,
): Promise<string> {
  try {
    const head = await ensureCheckoutExists(task);
    await verifyTaskWorkingDirectory({ ...task, head });
    return head;
  } catch (error) {
    if (error instanceof GitContextServiceError) throw error;
    throw workingDirectoryError(
      task,
      "Task working directory could not be initialized or recovered.",
      error,
    );
  }
}

export async function verifyTaskWorkingDirectory(
  task: TaskInitializationRecord,
): Promise<void> {
  const stat = await lstat(task.workingPath).catch((error: NodeJS.ErrnoException) => {
    throw workingDirectoryError(task, "Task working directory does not exist.", error);
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw workingDirectoryError(task, "Task working path must be a normal directory.");
  }
  const checkoutRoot = await realpath(task.workingPath);
  const gitRoot = await runGit(["rev-parse", "--show-toplevel"], { cwd: checkoutRoot });
  if (resolve(gitRoot) !== resolve(checkoutRoot)) {
    throw workingDirectoryError(task, "Task working directory is not the root of its Git checkout.");
  }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: checkoutRoot });
  if (head !== task.head) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Task working directory does not match the canonical task HEAD.",
      retryable: true,
      details: { taskId: task.taskId, expectedHead: task.head, actualHead: head },
    });
  }
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: checkoutRoot });
  if (branch !== task.branch) {
    throw workingDirectoryError(task, "Task working directory is not on its durable branch.");
  }
  const origin = await runGit(["remote", "get-url", "origin"], { cwd: checkoutRoot });
  if (resolve(origin) !== resolve(task.repositoryPath)) {
    throw workingDirectoryError(task, "Task working directory origin does not match its canonical repository.");
  }
  const dirty = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: checkoutRoot,
  });
  if (dirty) {
    throw new GitContextServiceError({
      code: "TASK_CHECKOUT_DIRTY",
      message: "Task working directory contains uncommitted changes.",
      details: { taskId: task.taskId, workingDirectory: task.workingPath },
    });
  }
  await configureAyatiGitIdentity(checkoutRoot);
}

async function ensureCheckoutExists(task: TaskInitializationRecord): Promise<string> {
  const existing = await lstat(task.workingPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    await mkdir(dirname(task.workingPath), { recursive: true });
    await runGit([
      "clone",
      "--branch",
      task.branch,
      "--single-branch",
      "--",
      task.repositoryPath,
      task.workingPath,
    ], { cwd: dirname(task.workingPath) });
    return requireTaskHead(task);
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw workingDirectoryError(task, "Requested task working path is not a normal directory.");
  }
  const entries = await readdir(task.workingPath);
  if (entries.length === 0) {
    await runGit([
      "clone",
      "--branch",
      task.branch,
      "--single-branch",
      "--",
      task.repositoryPath,
      ".",
    ], { cwd: task.workingPath });
    return requireTaskHead(task);
  }
  const gitRoot = await readGitValue(task.workingPath, ["rev-parse", "--show-toplevel"]);
  if (gitRoot && resolve(gitRoot) !== resolve(task.workingPath)) {
    throw workingDirectoryError(task, "Task working directory is inside another Git checkout.");
  }
  if (gitRoot && task.status !== "initializing") {
    return await runGit(["rev-parse", "HEAD"], { cwd: task.workingPath });
  }
  return await importExistingWorkingDirectory(task, Boolean(gitRoot));
}

async function importExistingWorkingDirectory(
  task: TaskInitializationRecord,
  repositoryInitialized: boolean,
): Promise<string> {
  if (!repositoryInitialized && await lstat(join(task.workingPath, ".ayati")).catch(() => undefined)) {
    throw workingDirectoryError(
      task,
      "Existing task working directory contains reserved .ayati state.",
    );
  }
  if (!repositoryInitialized) {
    await runGit(["init", "--initial-branch=" + task.branch], { cwd: task.workingPath });
  }
  await configureAyatiGitIdentity(task.workingPath);
  const origin = await readGitValue(task.workingPath, ["remote", "get-url", "origin"]);
  if (origin && resolve(origin) !== resolve(task.repositoryPath)) {
    throw workingDirectoryError(task, "Existing task working directory has a different Git origin.");
  }
  if (!origin) {
    await runGit(["remote", "add", "origin", task.repositoryPath], { cwd: task.workingPath });
  }
  await runGit(["fetch", "origin", task.branch], { cwd: task.workingPath });
  await runGit(["reset", "--mixed", "origin/" + task.branch], { cwd: task.workingPath });
  await runGit(["checkout", "origin/" + task.branch, "--", ".ayati/task.md"], {
    cwd: task.workingPath,
  });
  await runGit(["add", "-A"], { cwd: task.workingPath });
  const staged = await runGit(["diff", "--cached", "--name-only"], { cwd: task.workingPath });
  if (staged) {
    await runGit(["commit", "-m", existingDirectoryCommitMessage(task)], {
      cwd: task.workingPath,
      env: gitCommitEnvironment(task.createdAt),
    });
  }
  await runGit(["push", "origin", "HEAD:refs/heads/" + task.branch], {
    cwd: task.workingPath,
  });
  return await runGit(["rev-parse", "HEAD"], { cwd: task.workingPath });
}

function requireTaskHead(task: TaskInitializationRecord): string {
  if (!task.head) {
    throw workingDirectoryError(task, "Task has no canonical HEAD.");
  }
  return task.head;
}

async function readGitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(args, { cwd });
  } catch {
    return undefined;
  }
}

function existingDirectoryCommitMessage(task: TaskInitializationRecord): string {
  return [
    "task: import existing working directory",
    "",
    "Task-Id: " + task.taskId,
    "Created-Session: " + task.createdSessionId,
    "Ayati-Event: task_existing_files_imported",
  ].join("\n");
}

function workingDirectoryError(
  task: TaskInitializationRecord,
  message: string,
  cause?: unknown,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "REPOSITORY_UNAVAILABLE",
    message,
    retryable: false,
    details: {
      taskId: task.taskId,
      workingDirectory: task.workingPath,
      ...(cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : {}),
    },
  });
}
