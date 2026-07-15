import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GitContextServiceError } from "../errors.js";
import type { TaskInitializationRecord } from "../repositories/task-records.js";
import { configureAyatiGitIdentity, runGit } from "./git-process.js";

export async function ensureTaskWorkingDirectory(
  task: TaskInitializationRecord,
): Promise<string> {
  try {
    await ensureCheckoutExists(task);
    await verifyTaskWorkingDirectory(task);
    return task.workingPath;
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

async function ensureCheckoutExists(task: TaskInitializationRecord): Promise<void> {
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
    return;
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
  }
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
