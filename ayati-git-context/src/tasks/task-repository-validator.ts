import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

const MANAGED_INBOX_IGNORE_RULES = [
  ".ayati/inbox/*",
  "!.ayati/inbox/.gitkeep",
] as const;
const REQUESTED_INBOX_IGNORE_RULES = [
  "inbox/*",
  "!inbox/.gitkeep",
] as const;

export async function validateTaskRepository(input: {
  taskRoot: string;
  repositoryPath: string;
  expectedTaskId?: string;
  placement?: "managed" | "requested";
  trustedRoot?: string;
  requestReadMode?: "all" | "current";
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
  placement?: "managed" | "requested";
  trustedRoot?: string;
  requestReadMode?: "all" | "current";
}): Promise<TaskRepositoryValidation> {
  const placement = input.placement ?? "managed";
  const root = placement === "managed"
    ? await realpath(input.taskRoot).catch((error: NodeJS.ErrnoException) => {
        throw invalidRepository("Configured task root is unavailable.", {
          taskRoot: input.taskRoot,
          cause: error.message,
        });
      })
    : resolve(input.taskRoot);
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
  if (placement === "managed") {
    if (dirname(repositoryPath) !== root) {
      throw invalidRepository("Managed task repository must be a direct child of the task root.", {
        taskRoot: root,
        repositoryPath,
      });
    }
  } else {
    const trustedRoot = input.trustedRoot
      ? await realpath(input.trustedRoot).catch(() => undefined)
      : undefined;
    if (!trustedRoot || !isWithinPath(trustedRoot, repositoryPath)) {
      throw invalidRepository("Requested task repository is outside its recorded trusted root.", {
        trustedRoot: input.trustedRoot,
        repositoryPath,
      });
    }
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
  const ayatiPaths = (await git(repositoryPath, [
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ".ayati",
  ]))
    .split("\n")
    .filter(Boolean);
  const trackedAyati = new Set(ayatiPaths);
  requireTracked(trackedAyati, TASK_CARD_PATH);
  requireTracked(trackedAyati, TASK_REFERENCES_PATH);
  requireTracked(trackedAyati, TASK_INBOX_KEEP_PATH);
  validateAyatiPaths(ayatiPaths);

  const taskCard = parseTaskCard(
    await committedFile(repositoryPath, TASK_CARD_PATH),
    input.expectedTaskId,
  );
  if (placement === "managed" && !basename(repositoryPath).startsWith(taskCard.id + "-")) {
    throw new GitContextServiceError({
      code: "TASK_ID_MISMATCH",
      message: "Task repository directory does not begin with its task identity.",
      details: { taskId: taskCard.id, repositoryPath },
    });
  }
  const requestPaths = ayatiPaths.filter(
    (path) => path.startsWith(TASK_REQUESTS_DIRECTORY + "/"),
  );
  validateRequestPaths(requestPaths);
  const requests = input.requestReadMode === "current"
    ? await readCurrentRequest(repositoryPath, requestPaths, taskCard)
    : await readRequests(repositoryPath, requestPaths);
  const currentRequest = input.requestReadMode === "current"
    ? requests[0]
    : validateCurrentRequest(taskCard, requests);
  const references = parseTaskReferences(
    await committedFile(repositoryPath, TASK_REFERENCES_PATH),
  );
  validateReferenceRequests(references, requestPaths);
  await validateAdoptedPaths(repositoryPath, references);
  const ignorePath = placement === "managed" ? ".gitignore" : ".ayati/.gitignore";
  validateInboxIgnore(
    await committedFile(repositoryPath, ignorePath),
    placement === "managed" ? MANAGED_INBOX_IGNORE_RULES : REQUESTED_INBOX_IGNORE_RULES,
  );

  const importantPathPresence = await Promise.all(taskCard.importantPaths.map(async (entry) => ({
    path: entry.path,
    exists: await committedPathExists(repositoryPath, entry.path),
  })));
  const missingImportantPaths = importantPathPresence
    .filter((entry) => !entry.exists)
    .map((entry) => entry.path);
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

async function readRequests(repositoryPath: string, paths: string[]): Promise<TaskRequest[]> {
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

function validateRequestPaths(paths: string[]): void {
  const ids = new Set<string>();
  for (const path of paths) {
    const name = basename(path);
    const id = name.slice(0, 6);
    if (!/^R-\d{4}-.+\.md$/.test(name) || !isRequestId(id)) {
      throw invalidRepository("Task request directory contains an invalid tracked path.", { path });
    }
    if (ids.has(id)) {
      throw new GitContextServiceError({
        code: "TASK_REQUEST_INVALID",
        message: "Task repository contains duplicate request identities.",
        details: { requestId: id },
      });
    }
    ids.add(id);
  }
}

async function readCurrentRequest(
  repositoryPath: string,
  paths: string[],
  taskCard: TaskCard,
): Promise<TaskRequest[]> {
  if (!taskCard.currentRequest) return [];
  const matches = paths.filter((path) => basename(path).startsWith(taskCard.currentRequest + "-"));
  if (matches.length !== 1 || !matches[0]) {
    throw new GitContextServiceError({
      code: "TASK_CURRENT_REQUEST_INVALID",
      message: "Task card current request must have exactly one committed request file.",
      details: { currentRequest: taskCard.currentRequest },
    });
  }
  const request = parseTaskRequest(
    await committedFile(repositoryPath, matches[0]),
    taskCard.currentRequest,
  );
  if (request.status !== "active" || taskCard.status !== "active") {
    throw new GitContextServiceError({
      code: "TASK_CURRENT_REQUEST_INVALID",
      message: "The current request and task must both be active.",
      details: { currentRequest: taskCard.currentRequest, requestStatus: request.status },
    });
  }
  if (requestFileName(request.id, request.title) !== basename(matches[0])) {
    throw new GitContextServiceError({
      code: "TASK_REQUEST_INVALID",
      message: "Task request filename does not match its identity and title.",
      details: { path: matches[0], requestId: request.id },
    });
  }
  return [request];
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
  requestPaths: string[],
): void {
  const requestIds = new Set(requestPaths.map((path) => basename(path).slice(0, 6)));
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

async function validateAdoptedPaths(
  repositoryPath: string,
  references: TaskReference[],
): Promise<void> {
  for (const reference of references) {
    if (reference.adoptedPath
      && !await committedPathExists(repositoryPath, reference.adoptedPath)) {
      throw new GitContextServiceError({
        code: "TASK_REFERENCES_INVALID",
        message: "Task reference adopted path is not present in committed task content.",
        details: { referenceId: reference.id, adoptedPath: reference.adoptedPath },
      });
    }
  }
}

function validateInboxIgnore(content: string, requiredRules: readonly string[]): void {
  const lines = new Set(content.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim()));
  const missing = requiredRules.filter((rule) => !lines.has(rule));
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
    && path !== ".ayati/.gitignore"
    && !path.startsWith(TASK_REQUESTS_DIRECTORY + "/"));
  const trackedInbox = paths.filter((path) => path.startsWith(".ayati/inbox/")
    && path !== TASK_INBOX_KEEP_PATH);
  if (unexpected.length > 0 || trackedInbox.length > 0) {
    throw invalidRepository("Task repository contains unsupported tracked Ayati paths.", {
      unexpectedPaths: [...new Set([...unexpected, ...trackedInbox])],
    });
  }
}

function isWithinPath(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function requireTracked(tracked: ReadonlySet<string>, path: string): void {
  if (!tracked.has(path)) {
    throw invalidRepository("Task repository is missing a required tracked file.", { path });
  }
}

async function committedFile(repositoryPath: string, path: string): Promise<string> {
  return await runGitRaw(["show", "HEAD:" + path], { cwd: repositoryPath });
}

async function committedPathExists(repositoryPath: string, path: string): Promise<boolean> {
  try {
    await runGit(["cat-file", "-e", "HEAD:" + path], { cwd: repositoryPath });
    return true;
  } catch {
    return false;
  }
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
