import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../files/atomic-file.js";
import { GitContextServiceError } from "../errors.js";
import type { TaskInitializationRecord } from "../repositories/task-records.js";
import { renderInitialTaskDescriptor } from "../tasks/task-descriptor.js";
import {
  configureAyatiGitIdentity,
  gitCommitEnvironment,
  runGit,
} from "./git-process.js";

export async function ensureCanonicalTaskRepository(input: {
  task: TaskInitializationRecord;
  dataRoot: string;
}): Promise<string> {
  try {
    return await initializeCanonicalTaskRepository(input);
  } catch (error) {
    if (error instanceof GitContextServiceError) {
      throw error;
    }
    throw repositoryError(
      input.task.taskId,
      "Canonical task repository could not be initialized or recovered.",
      error,
    );
  }
}

async function initializeCanonicalTaskRepository(input: {
  task: TaskInitializationRecord;
  dataRoot: string;
}): Promise<string> {
  const tasksRoot = join(input.dataRoot, "tasks");
  await mkdir(tasksRoot, { recursive: true });
  await ensureBareRepository(input.task.repositoryPath, tasksRoot);
  const existingHead = await readBranchHead(
    input.task.repositoryPath,
    input.task.branch,
  );
  if (!existingHead) {
    await createIdentityCommit(input);
  }
  const head = await readBranchHead(input.task.repositoryPath, input.task.branch);
  if (!head) {
    throw repositoryError(input.task.taskId, "Task repository has no durable branch HEAD.");
  }
  await runGit(["symbolic-ref", "HEAD", "refs/heads/" + input.task.branch], {
    cwd: input.task.repositoryPath,
  });
  await verifyInitialTaskDescriptor(input.task, head);
  return head;
}

export async function verifyCanonicalTaskRepository(
  task: TaskInitializationRecord,
): Promise<void> {
  const isBare = await readBareState(task.repositoryPath);
  if (isBare !== "true") {
    throw repositoryError(task.taskId, "Canonical task repository is missing or is not bare.");
  }
  const head = await readBranchHead(task.repositoryPath, task.branch);
  if (!head || head !== task.head) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Canonical task repository HEAD does not match the task catalog.",
      retryable: true,
      details: {
        taskId: task.taskId,
        expectedHead: task.head,
        actualHead: head ?? null,
      },
    });
  }
  await verifyPortableTaskIdentity(task, head);
}

async function ensureBareRepository(repositoryPath: string, tasksRoot: string): Promise<void> {
  if (!await pathExists(repositoryPath)) {
    await runGit([
      "init",
      "--bare",
      "--initial-branch=main",
      repositoryPath,
    ], { cwd: tasksRoot });
    return;
  }
  const bareState = await readBareState(repositoryPath);
  if (bareState === "true") {
    return;
  }
  if (bareState === undefined) {
    await runGit([
      "init",
      "--bare",
      "--initial-branch=main",
      repositoryPath,
    ], { cwd: tasksRoot });
    return;
  }
  throw new Error("Canonical task path exists but is not a bare Git repository.");
}

async function createIdentityCommit(input: {
  task: TaskInitializationRecord;
  dataRoot: string;
}): Promise<void> {
  const stagingRoot = join(input.dataRoot, "staging");
  await mkdir(stagingRoot, { recursive: true });
  const checkout = join(stagingRoot, input.task.taskId);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(checkout, { recursive: true });
  try {
    await runGit(["init", "--initial-branch=main"], { cwd: checkout });
    await configureAyatiGitIdentity(checkout);
    const descriptor = renderInitialTaskDescriptor({
      taskId: input.task.taskId,
      title: input.task.title,
      objective: input.task.objective,
    });
    await writeFileAtomically(join(checkout, ".ayati", "task.md"), descriptor);
    await runGit(["add", "--", ".ayati/task.md"], { cwd: checkout });
    await runGit(["commit", "-m", identityCommitMessage(input.task)], {
      cwd: checkout,
      env: gitCommitEnvironment(input.task.createdAt),
    });
    await runGit([
      "push",
      input.task.repositoryPath,
      "HEAD:refs/heads/" + input.task.branch,
    ], { cwd: checkout });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

async function verifyInitialTaskDescriptor(
  task: TaskInitializationRecord,
  head: string,
): Promise<void> {
  const expected = renderInitialTaskDescriptor({
    taskId: task.taskId,
    title: task.title,
    objective: task.objective,
  });
  let actual: string;
  try {
    actual = await runGit(["show", head + ":.ayati/task.md"], {
      cwd: task.repositoryPath,
    });
  } catch (error) {
    throw repositoryError(
      task.taskId,
      "Task repository is missing its portable descriptor.",
      error,
    );
  }
  if (actual + "\n" !== expected) {
    throw repositoryError(task.taskId, "Task descriptor does not match the catalog identity.");
  }
}

async function verifyPortableTaskIdentity(
  task: TaskInitializationRecord,
  head: string,
): Promise<void> {
  let descriptor: string;
  try {
    descriptor = await runGit(["show", head + ":.ayati/task.md"], {
      cwd: task.repositoryPath,
    });
  } catch (error) {
    throw repositoryError(
      task.taskId,
      "Task repository is missing its portable descriptor.",
      error,
    );
  }
  const identityLines = descriptor
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Task: "));
  if (identityLines.length !== 1 || identityLines[0] !== "Task: " + task.taskId) {
    throw repositoryError(task.taskId, "Task descriptor identity does not match the catalog.");
  }
}

async function readBranchHead(
  repositoryPath: string,
  branch: string,
): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "refs/heads/" + branch], {
      cwd: repositoryPath,
    });
  } catch {
    return undefined;
  }
}

async function readBareState(repositoryPath: string): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "--is-bare-repository"], {
      cwd: repositoryPath,
    });
  } catch {
    return undefined;
  }
}

function identityCommitMessage(task: TaskInitializationRecord): string {
  return [
    "task: create " + task.title.toLowerCase(),
    "",
    "Task-Id: " + task.taskId,
    "Task-Title: " + task.title,
    "Created-Session: " + task.createdSessionId,
    "Ayati-Event: task_created",
  ].join("\n");
}

function repositoryError(
  taskId: string,
  message: string,
  cause?: unknown,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "REPOSITORY_UNAVAILABLE",
    message,
    retryable: true,
    details: {
      taskId,
      ...(cause
        ? { cause: cause instanceof Error ? cause.message : String(cause) }
        : {}),
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
