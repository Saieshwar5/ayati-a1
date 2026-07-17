import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { parseTaskCard, type TaskCard } from "./task-card.js";
import { parseTaskReferences, type TaskReference } from "./task-references.js";
import {
  isRequestId,
  requestFileName,
  TASK_CARD_PATH,
  TASK_INBOX_KEEP_PATH,
  TASK_REFERENCES_PATH,
  TASK_REQUESTS_DIRECTORY,
} from "./task-repository-layout.js";
import { parseTaskRequest, type TaskRequest } from "./task-request.js";

export type TaskRepositoryHealth = "ready" | "dirty_external";

export interface TaskRepositoryValidation {
  taskId: string;
  repositoryPath: string;
  branch: string;
  head: string;
  health: TaskRepositoryHealth;
  taskCard: TaskCard;
  currentRequest?: TaskRequest;
  requests: TaskRequest[];
  references: TaskReference[];
  missingImportantPaths: string[];
  workingTreeChanges: string[];
}

const REQUIRED_INBOX_IGNORE_RULES = [
  ".ayati/inbox/*",
  "!.ayati/inbox/.gitkeep",
] as const;

export async function validateTaskRepository(input: {
  taskRoot: string;
  repositoryPath: string;
  expectedTaskId?: string;
}): Promise<TaskRepositoryValidation> {
  try {
    return await validate(input);
  } catch (error) {
    if (error instanceof GitContextServiceError) throw error;
    throw invalidRepository("Task repository validation failed.", {
      repositoryPath: input.repositoryPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function validate(input: {
  taskRoot: string;
  repositoryPath: string;
  expectedTaskId?: string;
}): Promise<TaskRepositoryValidation> {
  const root = await realpath(input.taskRoot).catch((error: NodeJS.ErrnoException) => {
    throw invalidRepository("Configured task root is unavailable.", {
      taskRoot: input.taskRoot,
      cause: error.message,
    });
  });
  const stat = await lstat(input.repositoryPath).catch((error: NodeJS.ErrnoException) => {
    throw invalidRepository("Task repository directory is unavailable.", {
      repositoryPath: input.repositoryPath,
      health: "missing",
      cause: error.message,
    });
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalidRepository("Task repository path must be a normal directory.", {
      repositoryPath: input.repositoryPath,
    });
  }
  const repositoryPath = await realpath(input.repositoryPath);
  if (dirname(repositoryPath) !== root) {
    throw invalidRepository("Task repository must be a direct child of the configured task root.", {
      taskRoot: root,
      repositoryPath,
    });
  }
  const gitRoot = resolve(await git(repositoryPath, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== resolve(repositoryPath)) {
    throw invalidRepository("Task directory is not the exact Git repository root.", {
      repositoryPath,
      gitRoot,
    });
  }
  if (await git(repositoryPath, ["rev-parse", "--is-bare-repository"]) !== "false") {
    throw invalidRepository("V1 task repository must be non-bare.", { repositoryPath });
  }
  const head = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const branch = await git(repositoryPath, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch) {
    throw invalidRepository("V1 task repository must have an attached durable branch.", {
      repositoryPath,
    });
  }
  const trackedPaths = (await git(repositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]))
    .split("\n")
    .filter(Boolean);
  const tracked = new Set(trackedPaths);
  requireTracked(tracked, TASK_CARD_PATH);
  requireTracked(tracked, TASK_REFERENCES_PATH);
  requireTracked(tracked, TASK_INBOX_KEEP_PATH);
  requireTracked(tracked, ".gitignore");
  validateAyatiPaths(trackedPaths);

  const taskCard = parseTaskCard(
    await committedFile(repositoryPath, TASK_CARD_PATH),
    input.expectedTaskId,
  );
  if (!basename(repositoryPath).startsWith(taskCard.id + "-")) {
    throw new GitContextServiceError({
      code: "TASK_ID_MISMATCH",
      message: "Task repository directory does not begin with its task identity.",
      details: { taskId: taskCard.id, repositoryPath },
    });
  }
  const requests = await readRequests(repositoryPath, trackedPaths);
  const currentRequest = validateCurrentRequest(taskCard, requests);
  const references = parseTaskReferences(
    await committedFile(repositoryPath, TASK_REFERENCES_PATH),
  );
  validateReferenceRequests(references, requests);
  validateAdoptedPaths(references, tracked);
  validateInboxIgnore(await committedFile(repositoryPath, ".gitignore"));

  const missingImportantPaths = taskCard.importantPaths
    .map((entry) => entry.path)
    .filter((path) => !trackedPathExists(trackedPaths, path));
  const statusOutput = await runGitRaw([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], { cwd: repositoryPath });
  const workingTreeChanges = statusOutput
    .replaceAll("\r\n", "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter(Boolean);
  return {
    taskId: taskCard.id,
    repositoryPath,
    branch,
    head,
    health: workingTreeChanges.length > 0 ? "dirty_external" : "ready",
    taskCard,
    ...(currentRequest ? { currentRequest } : {}),
    requests,
    references,
    missingImportantPaths,
    workingTreeChanges,
  };
}

async function readRequests(repositoryPath: string, trackedPaths: string[]): Promise<TaskRequest[]> {
  const paths = trackedPaths.filter((path) => path.startsWith(TASK_REQUESTS_DIRECTORY + "/"));
  const requests: TaskRequest[] = [];
  const ids = new Set<string>();
  for (const path of paths) {
    const name = basename(path);
    const id = name.slice(0, 6);
    if (!/^R-\d{4}-.+\.md$/.test(name) || !isRequestId(id)) {
      throw invalidRepository("Task request directory contains an invalid tracked path.", { path });
    }
    const request = parseTaskRequest(await committedFile(repositoryPath, path), id);
    if (requestFileName(request.id, request.title) !== name) {
      throw new GitContextServiceError({
        code: "TASK_REQUEST_INVALID",
        message: "Task request filename does not match its identity and title.",
        details: { path, requestId: request.id },
      });
    }
    if (ids.has(request.id)) {
      throw new GitContextServiceError({
        code: "TASK_REQUEST_INVALID",
        message: "Task repository contains duplicate request identities.",
        details: { requestId: request.id },
      });
    }
    ids.add(request.id);
    requests.push(request);
  }
  return requests.sort((left, right) => left.id.localeCompare(right.id));
}

function validateCurrentRequest(
  taskCard: TaskCard,
  requests: TaskRequest[],
): TaskRequest | undefined {
  const active = requests.filter((request) => request.status === "active");
  if (taskCard.status !== "active" && active.length > 0) {
    throw new GitContextServiceError({
      code: "TASK_CURRENT_REQUEST_INVALID",
      message: "Paused or archived tasks cannot contain an active request.",
      details: { taskStatus: taskCard.status, activeRequestId: active[0]?.id },
    });
  }
  if (active.length > 1) {
    throw new GitContextServiceError({
      code: "TASK_CURRENT_REQUEST_INVALID",
      message: "Task repository may contain at most one active request.",
      details: { activeRequestIds: active.map((request) => request.id) },
    });
  }
  if (!taskCard.currentRequest) {
    if (active.length > 0) {
      throw new GitContextServiceError({
        code: "TASK_CURRENT_REQUEST_INVALID",
        message: "Task card has no current request but an active request exists.",
        details: { activeRequestId: active[0]?.id },
      });
    }
    return undefined;
  }
  const current = requests.find((request) => request.id === taskCard.currentRequest);
  if (!current || current.status !== "active" || active[0]?.id !== current.id) {
    throw new GitContextServiceError({
      code: "TASK_CURRENT_REQUEST_INVALID",
      message: "Task card current request must name the repository's one active request.",
      details: { currentRequest: taskCard.currentRequest },
    });
  }
  return current;
}

function validateReferenceRequests(
  references: TaskReference[],
  requests: TaskRequest[],
): void {
  const requestIds = new Set(requests.map((request) => request.id));
  for (const reference of references) {
    const missing = reference.requestIds.filter((requestId) => !requestIds.has(requestId));
    if (missing.length > 0) {
      throw new GitContextServiceError({
        code: "TASK_REFERENCES_INVALID",
        message: "Task reference names a request that does not exist.",
        details: { referenceId: reference.id, missingRequestIds: missing },
      });
    }
  }
}

function validateAdoptedPaths(references: TaskReference[], tracked: ReadonlySet<string>): void {
  for (const reference of references) {
    if (reference.adoptedPath && !trackedPathExists([...tracked], reference.adoptedPath)) {
      throw new GitContextServiceError({
        code: "TASK_REFERENCES_INVALID",
        message: "Task reference adopted path is not present in committed task content.",
        details: { referenceId: reference.id, adoptedPath: reference.adoptedPath },
      });
    }
  }
}

function validateInboxIgnore(content: string): void {
  const lines = new Set(content.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim()));
  const missing = REQUIRED_INBOX_IGNORE_RULES.filter((rule) => !lines.has(rule));
  if (missing.length > 0) {
    throw invalidRepository("Task repository is missing required inbox ignore rules.", {
      missingRules: missing,
    });
  }
}

function validateAyatiPaths(paths: string[]): void {
  const unexpected = paths.filter((path) => path.startsWith(".ayati/")
    && path !== TASK_CARD_PATH
    && path !== TASK_REFERENCES_PATH
    && path !== TASK_INBOX_KEEP_PATH
    && !path.startsWith(TASK_REQUESTS_DIRECTORY + "/"));
  const trackedInbox = paths.filter((path) => path.startsWith(".ayati/inbox/")
    && path !== TASK_INBOX_KEEP_PATH);
  if (unexpected.length > 0 || trackedInbox.length > 0) {
    throw invalidRepository("Task repository contains unsupported tracked Ayati paths.", {
      unexpectedPaths: [...new Set([...unexpected, ...trackedInbox])],
    });
  }
}

function requireTracked(tracked: ReadonlySet<string>, path: string): void {
  if (!tracked.has(path)) {
    throw invalidRepository("Task repository is missing a required tracked file.", { path });
  }
}

function trackedPathExists(paths: readonly string[], path: string): boolean {
  return paths.some((candidate) => candidate === path || candidate.startsWith(path + "/"));
}

async function committedFile(repositoryPath: string, path: string): Promise<string> {
  return await runGitRaw(["show", "HEAD:" + path], { cwd: repositoryPath });
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  return await runGit(args, { cwd: repositoryPath });
}

function invalidRepository(
  message: string,
  details?: Record<string, unknown>,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
