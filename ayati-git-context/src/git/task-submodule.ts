import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionRef, TaskCatalogEntry } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import type { TaskMountRecord } from "../repositories/task-mount-records.js";
import { runGit } from "./git-process.js";

export async function ensureTaskSubmodule(input: {
  session: SessionRef;
  task: TaskCatalogEntry;
  mount: TaskMountRecord;
}): Promise<string> {
  try {
    return await initializeTaskSubmodule(input);
  } catch (error) {
    if (error instanceof GitContextServiceError) {
      throw error;
    }
    throw mountRecoveryError(
      input,
      "Task submodule could not be initialized or recovered.",
      error,
    );
  }
}

async function initializeTaskSubmodule(input: {
  session: SessionRef;
  task: TaskCatalogEntry;
  mount: TaskMountRecord;
}): Promise<string> {
  validateMountIdentity(input);
  const sessionHead = await runGit(["rev-parse", "HEAD"], {
    cwd: input.session.repositoryPath,
  });
  if (sessionHead !== input.session.head) {
    throw new GitContextServiceError({
      code: "SESSION_HEAD_MISMATCH",
      message: "Session repository HEAD changed before task mounting.",
      retryable: true,
      details: {
        sessionId: input.session.sessionId,
        expectedHead: input.session.head,
        actualHead: sessionHead,
      },
    });
  }

  const relativePath = "tasks/" + input.task.taskId;
  const expectedUrl = portableRelativePath(
    relative(input.session.repositoryPath, input.task.repositoryPath),
  );
  const configuration = await readSubmoduleConfiguration(
    input.session.repositoryPath,
    input.task.taskId,
  );
  const checkoutExists = await pathExists(input.mount.checkoutPath);
  const indexEntry = await readGitlink(input.session.repositoryPath, relativePath);

  if (!configuration && !checkoutExists && !indexEntry) {
    await addSubmodule(input, expectedUrl, relativePath);
  } else {
    if (!configuration) {
      throw mountRecoveryError(input, "Task checkout or gitlink exists without .gitmodules ownership.");
    }
    verifySubmoduleConfiguration(input, configuration, relativePath, expectedUrl);
    if (!checkoutExists && !indexEntry) {
      await removeSubmoduleConfiguration(input.session.repositoryPath, input.task.taskId);
      await addSubmodule(input, expectedUrl, relativePath);
    } else if (!checkoutExists) {
      await initializeSubmodule(input.session.repositoryPath, relativePath);
    } else if (!indexEntry) {
      await verifyCheckout(input, expectedUrl);
      await runGit(["add", "--", ".gitmodules", relativePath], {
        cwd: input.session.repositoryPath,
      });
    }
  }

  await verifyCheckout(input, expectedUrl);
  await runGit(["add", "--", ".gitmodules", relativePath], {
    cwd: input.session.repositoryPath,
  });
  const finalGitlink = await readGitlink(input.session.repositoryPath, relativePath);
  if (!finalGitlink || finalGitlink !== input.task.head) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Session gitlink does not match the canonical task HEAD.",
      retryable: true,
      details: {
        sessionId: input.session.sessionId,
        taskId: input.task.taskId,
        expectedHead: input.task.head,
        actualHead: finalGitlink ?? null,
      },
    });
  }
  return finalGitlink;
}

async function addSubmodule(
  input: { session: SessionRef; task: TaskCatalogEntry },
  expectedUrl: string,
  relativePath: string,
): Promise<void> {
  await ensureNormalDirectory(dirname(resolve(input.session.repositoryPath, relativePath)), input);
  await runGit([
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    input.task.taskId,
    "-b",
    input.task.branch,
    "--",
    expectedUrl,
    relativePath,
  ], { cwd: input.session.repositoryPath });
}

async function initializeSubmodule(
  sessionRepository: string,
  relativePath: string,
): Promise<void> {
  await runGit([
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--checkout",
    "--",
    relativePath,
  ], { cwd: sessionRepository });
}

async function verifyCheckout(
  input: { session: SessionRef; task: TaskCatalogEntry; mount: TaskMountRecord },
  expectedUrl: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(input.mount.checkoutPath);
  } catch (error) {
    throw mountRecoveryError(input, "Task checkout path disappeared during verification.", error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw mountRecoveryError(input, "Task checkout path is not a normal directory.");
  }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.mount.checkoutPath });
  if (head !== input.task.head) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Task checkout does not match the canonical task HEAD.",
      retryable: true,
      details: {
        sessionId: input.session.sessionId,
        taskId: input.task.taskId,
        expectedHead: input.task.head,
        actualHead: head,
      },
    });
  }
  await requireCleanCheckout(input);
  await attachDurableBranch(input.mount.checkoutPath, input.task.branch);
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], {
    cwd: input.mount.checkoutPath,
  });
  if (branch !== input.task.branch) {
    throw mountRecoveryError(input, "Task checkout is not on its durable branch.");
  }
  await requireCleanCheckout(input);
  const origin = await runGit(["remote", "get-url", "origin"], {
    cwd: input.mount.checkoutPath,
  });
  if (!sameRepository(origin, expectedUrl, input)) {
    throw mountRecoveryError(input, "Task checkout origin does not match the canonical repository.");
  }
}

async function attachDurableBranch(checkoutPath: string, branch: string): Promise<void> {
  try {
    await runGit(["show-ref", "--verify", "refs/heads/" + branch], {
      cwd: checkoutPath,
    });
    await runGit(["switch", branch], { cwd: checkoutPath });
  } catch {
    await runGit(["switch", "-c", branch, "--track", "origin/" + branch], {
      cwd: checkoutPath,
    });
  }
}

interface SubmoduleConfiguration {
  path: string;
  url: string;
  branch?: string;
}

async function readSubmoduleConfiguration(
  sessionRepository: string,
  taskId: string,
): Promise<SubmoduleConfiguration | undefined> {
  const path = await readGitmodulesValue(sessionRepository, "submodule." + taskId + ".path");
  const url = await readGitmodulesValue(sessionRepository, "submodule." + taskId + ".url");
  if (!path && !url) {
    return undefined;
  }
  if (!path || !url) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Task submodule configuration is incomplete.",
      retryable: false,
      details: { taskId },
    });
  }
  const branch = await readGitmodulesValue(
    sessionRepository,
    "submodule." + taskId + ".branch",
  );
  return { path, url, ...(branch ? { branch } : {}) };
}

async function readGitmodulesValue(
  sessionRepository: string,
  key: string,
): Promise<string | undefined> {
  try {
    return await runGit(["config", "-f", ".gitmodules", "--get", key], {
      cwd: sessionRepository,
    });
  } catch {
    return undefined;
  }
}

function verifySubmoduleConfiguration(
  input: { session: SessionRef; task: TaskCatalogEntry },
  configuration: SubmoduleConfiguration,
  relativePath: string,
  expectedUrl: string,
): void {
  if (configuration.path !== relativePath
    || configuration.url !== expectedUrl
    || configuration.branch !== input.task.branch) {
    throw mountRecoveryError(input, "Task submodule configuration does not match catalog ownership.");
  }
}

async function removeSubmoduleConfiguration(
  sessionRepository: string,
  taskId: string,
): Promise<void> {
  await runGit([
    "config",
    "-f",
    ".gitmodules",
    "--remove-section",
    "submodule." + taskId,
  ], { cwd: sessionRepository });
}

async function readGitlink(
  sessionRepository: string,
  relativePath: string,
): Promise<string | undefined> {
  const output = await runGit(["ls-files", "--stage", "--", relativePath], {
    cwd: sessionRepository,
  });
  if (!output) {
    return undefined;
  }
  const match = output.match(/^160000 ([a-f0-9]{40}) 0\t/);
  return match?.[1];
}

function sameRepository(
  actual: string,
  expectedRelative: string,
  input: { session: SessionRef; task: TaskCatalogEntry },
): boolean {
  if (actual === input.task.repositoryPath || actual === expectedRelative) {
    return true;
  }
  if (!isAbsolute(actual)) {
    return resolve(input.session.repositoryPath, actual) === input.task.repositoryPath;
  }
  return resolve(actual) === resolve(input.task.repositoryPath);
}

function validateMountIdentity(input: {
  session: SessionRef;
  task: TaskCatalogEntry;
  mount: TaskMountRecord;
}): void {
  const expectedCheckout = resolve(
    input.session.repositoryPath,
    "tasks",
    input.task.taskId,
  );
  if (input.mount.sessionId !== input.session.sessionId
    || input.mount.taskId !== input.task.taskId
    || resolve(input.mount.checkoutPath) !== expectedCheckout
    || resolve(input.mount.canonicalRepository) !== resolve(input.task.repositoryPath)
    || input.mount.branch !== input.task.branch) {
    throw mountRecoveryError(input, "SQLite task mount identity is inconsistent.");
  }
}

function mountRecoveryError(
  input: { session: SessionRef; task: TaskCatalogEntry },
  message: string,
  cause?: unknown,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    retryable: false,
    details: {
      sessionId: input.session.sessionId,
      taskId: input.task.taskId,
      ...(cause
        ? { cause: cause instanceof Error ? cause.message : String(cause) }
        : {}),
    },
  });
}

async function requireCleanCheckout(input: {
  session: SessionRef;
  task: TaskCatalogEntry;
  mount: TaskMountRecord;
}): Promise<void> {
  const dirty = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: input.mount.checkoutPath,
  });
  if (dirty.length > 0) {
    throw new GitContextServiceError({
      code: "TASK_CHECKOUT_DIRTY",
      message: "Task checkout contains uncommitted changes.",
      retryable: false,
      details: {
        sessionId: input.session.sessionId,
        taskId: input.task.taskId,
        checkoutPath: input.mount.checkoutPath,
      },
    });
  }
}

async function ensureNormalDirectory(
  path: string,
  input: { session: SessionRef; task: TaskCatalogEntry },
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw mountRecoveryError(input, "Session task directory is not a normal directory.");
    }
  } catch (error) {
    if (error instanceof GitContextServiceError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { recursive: true });
  }
}

function portableRelativePath(value: string): string {
  return value.split(sep).join("/");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
