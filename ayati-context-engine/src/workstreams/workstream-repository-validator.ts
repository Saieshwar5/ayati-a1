import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContextEngineServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { parseWorkstreamCard, type WorkstreamCard } from "./workstream-card.js";
import {
  parseWorkstreamProgress,
  type WorkstreamProgressEntry,
} from "./workstream-progress.js";
import {
  isRequestId,
  requireRequestPath,
  WORKSTREAM_CARD_PATH,
  WORKSTREAM_PROGRESS_PATH,
  WORKSTREAM_REQUESTS_DIRECTORY,
  WORKSTREAM_RESOURCES_PATH,
} from "./workstream-repository-layout.js";
import {
  parseWorkstreamResourceManifest,
  type WorkstreamResourceManifest,
} from "./workstream-resource-manifest.js";
import { parseWorkstreamRequest, type WorkstreamRequest } from "./workstream-request.js";

export type WorkstreamRepositoryHealth = "ready" | "dirty_external";

export interface WorkstreamRepositoryValidation {
  workstreamId: string;
  contextRepositoryPath: string;
  repositoryPath: string;
  branch: string;
  /** Last commit that changed this workstream directory. */
  head: string;
  /** Current HEAD of the shared repository. */
  repositoryHead: string;
  health: WorkstreamRepositoryHealth;
  workstreamCard: WorkstreamCard;
  currentRequest?: WorkstreamRequest;
  requests: WorkstreamRequest[];
  progress: {
    content: string;
    entries: WorkstreamProgressEntry[];
  };
  resourceManifest: WorkstreamResourceManifest;
  workingTreeChanges: string[];
}

export async function validateWorkstreamRepository(input: {
  workstreamRoot: string;
  contextRepositoryPath: string;
  expectedWorkstreamId?: string;
  requestReadMode?: "all" | "current";
}): Promise<WorkstreamRepositoryValidation> {
  try {
    return await validate(input);
  } catch (error) {
    if (error instanceof ContextEngineServiceError) throw error;
    throw invalidRepository("Shared workstream context validation failed.", {
      contextRepositoryPath: input.contextRepositoryPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function validate(input: {
  workstreamRoot: string;
  contextRepositoryPath: string;
  expectedWorkstreamId?: string;
  requestReadMode?: "all" | "current";
}): Promise<WorkstreamRepositoryValidation> {
  const repositoryPath = await realpath(input.workstreamRoot).catch(
    (error: NodeJS.ErrnoException) => {
      throw invalidRepository("Configured shared workstream repository is unavailable.", {
        workstreamRoot: input.workstreamRoot,
        cause: error.message,
      });
    },
  );
  const stat = await lstat(input.contextRepositoryPath).catch(
    (error: NodeJS.ErrnoException) => {
      throw invalidRepository("Workstream context directory is unavailable.", {
        contextRepositoryPath: input.contextRepositoryPath,
        health: "missing",
        cause: error.message,
      });
    },
  );
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalidRepository("Workstream context must be a normal directory.", {
      contextRepositoryPath: input.contextRepositoryPath,
    });
  }
  const contextRepositoryPath = await realpath(input.contextRepositoryPath);
  if (dirname(contextRepositoryPath) !== repositoryPath) {
    throw invalidRepository("Workstream context must be a direct child of the shared repository.", {
      workstreamRoot: repositoryPath,
      contextRepositoryPath,
    });
  }
  const gitRoot = resolve(await git(repositoryPath, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== resolve(repositoryPath)) {
    throw invalidRepository("Configured workstream root is not the shared Git repository root.", {
      repositoryPath,
      gitRoot,
    });
  }
  const nestedGit = await lstat(join(contextRepositoryPath, ".git")).then(() => true).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (nestedGit) {
    throw invalidRepository("Nested workstream Git repositories are forbidden.", {
      contextRepositoryPath,
    });
  }
  if (await git(repositoryPath, ["rev-parse", "--is-bare-repository"]) !== "false") {
    throw invalidRepository("Shared workstream repository must be non-bare.");
  }
  const repositoryHead = await git(repositoryPath, ["rev-parse", "HEAD"]);
  const branch = await git(repositoryPath, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") {
    throw invalidRepository("Shared workstream repository must use its attached main branch.", {
      branch,
    });
  }
  const directory = basename(contextRepositoryPath);
  const prefix = directory + "/";
  const lastCommit = await runGit([
    "log",
    "-1",
    "--format=%H",
    repositoryHead,
    "--",
    directory,
  ], { cwd: repositoryPath });
  if (!lastCommit) {
    throw invalidRepository("Workstream directory has no committed shared-repository history.", {
      directory,
    });
  }
  const repositoryPaths = lines(await runGit([
    "ls-tree",
    "-r",
    "--name-only",
    repositoryHead,
    "--",
    directory,
  ], { cwd: repositoryPath }));
  const trackedPaths = repositoryPaths.map((path) => {
    if (!path.startsWith(prefix)) {
      throw invalidRepository("Shared repository returned a path outside the workstream.", {
        directory,
        path,
      });
    }
    return path.slice(prefix.length);
  });
  const tracked = new Set(trackedPaths);
  requireTracked(tracked, WORKSTREAM_CARD_PATH);
  requireTracked(tracked, WORKSTREAM_PROGRESS_PATH);
  requireTracked(tracked, WORKSTREAM_RESOURCES_PATH);
  const unexpected = trackedPaths.filter((path) => path !== WORKSTREAM_CARD_PATH
    && path !== WORKSTREAM_PROGRESS_PATH
    && path !== WORKSTREAM_RESOURCES_PATH
    && !path.startsWith(WORKSTREAM_REQUESTS_DIRECTORY + "/"));
  if (unexpected.length > 0) {
    throw invalidRepository("Workstream directory contains non-context tracked paths.", {
      unexpectedPaths: unexpected,
    });
  }
  const committed = async (path: string): Promise<string> => (
    await committedFile(repositoryPath, prefix + path)
  );
  const progressContent = await committed(WORKSTREAM_PROGRESS_PATH);
  const progressEntries = parseWorkstreamProgress(progressContent);
  const card = parseWorkstreamCard(
    await committed(WORKSTREAM_CARD_PATH),
    input.expectedWorkstreamId,
  );
  if (!directory.startsWith(card.id + "-")) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_ID_MISMATCH",
      message: "Workstream directory does not begin with its workstream identity.",
      details: { workstreamId: card.id, contextRepositoryPath },
    });
  }
  const requestPaths = trackedPaths.filter(
    (path) => path.startsWith(WORKSTREAM_REQUESTS_DIRECTORY + "/"),
  );
  validateRequestPaths(requestPaths);
  const requests = input.requestReadMode === "current"
    ? await readCurrentRequest(requestPaths, card, committed)
    : await readRequests(requestPaths, card.id, committed);
  const currentRequest = input.requestReadMode === "current"
    ? requests[0]
    : validateCurrentRequest(card, requests);
  const resourceManifest = parseWorkstreamResourceManifest(
    await committed(WORKSTREAM_RESOURCES_PATH),
    card.id,
  );
  const status = await runGitRaw([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], { cwd: repositoryPath });
  const workingTreeChanges = status.replaceAll("\r\n", "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter(Boolean);
  return {
    workstreamId: card.id,
    contextRepositoryPath,
    repositoryPath,
    branch,
    head: lastCommit,
    repositoryHead,
    health: workingTreeChanges.length > 0 ? "dirty_external" : "ready",
    workstreamCard: card,
    ...(currentRequest ? { currentRequest } : {}),
    requests,
    progress: { content: progressContent, entries: progressEntries },
    resourceManifest,
    workingTreeChanges,
  };
}

async function readRequests(
  paths: string[],
  workstreamId: string,
  committed: (path: string) => Promise<string>,
): Promise<WorkstreamRequest[]> {
  const requests: WorkstreamRequest[] = [];
  const ids = new Set<string>();
  for (const path of paths) {
    const id = requireRequestPath(path).slice("requests/".length, "requests/R-0000".length);
    const request = parseWorkstreamRequest(await committed(path), id, path);
    if (request.workstreamId !== workstreamId) {
      throw invalidRepository("Request belongs to a different workstream.", {
        requestId: request.id,
        expectedWorkstreamId: workstreamId,
        actualWorkstreamId: request.workstreamId,
      });
    }
    if (ids.has(request.id)) {
      throw invalidRepository("Workstream contains duplicate request identities.", {
        requestId: request.id,
      });
    }
    ids.add(request.id);
    requests.push(request);
  }
  return requests.sort((left, right) => left.id.localeCompare(right.id));
}

async function readCurrentRequest(
  paths: string[],
  card: WorkstreamCard,
  committed: (path: string) => Promise<string>,
): Promise<WorkstreamRequest[]> {
  if (!card.currentRequest) return [];
  const matches = paths.filter(
    (path) => basename(path).startsWith(card.currentRequest + "-"),
  );
  if (matches.length !== 1 || !matches[0]) {
    throw currentInvalid("Workstream current request must have exactly one request file.", {
      currentRequest: card.currentRequest,
    });
  }
  const request = parseWorkstreamRequest(
    await committed(matches[0]),
    card.currentRequest,
    matches[0],
  );
  if (request.workstreamId !== card.id
    || request.status !== "active"
    || card.status !== "active") {
    throw currentInvalid("The current request and workstream must both be active.", {
      currentRequest: card.currentRequest,
      requestStatus: request.status,
      workstreamStatus: card.status,
    });
  }
  return [request];
}

function validateRequestPaths(paths: string[]): void {
  const ids = new Set<string>();
  for (const path of paths) {
    requireRequestPath(path);
    const name = basename(path);
    const id = name.slice(0, 6);
    if (!isRequestId(id) || ids.has(id)) {
      throw invalidRepository("Request directory contains an invalid or duplicate path.", {
        path,
      });
    }
    ids.add(id);
  }
}

function validateCurrentRequest(
  card: WorkstreamCard,
  requests: WorkstreamRequest[],
): WorkstreamRequest | undefined {
  const active = requests.filter((request) => request.status === "active");
  if (card.status !== "active" && active.length > 0) {
    throw currentInvalid("Paused or archived workstreams cannot contain an active request.");
  }
  if (active.length > 1) {
    throw currentInvalid("Workstream may contain at most one active request.", {
      activeRequestIds: active.map((request) => request.id),
    });
  }
  if (!card.currentRequest) {
    if (active.length > 0) {
      throw currentInvalid("Workstream has no current request but an active request exists.");
    }
    return undefined;
  }
  const current = requests.find((request) => request.id === card.currentRequest);
  if (!current || current.status !== "active" || active[0]?.id !== current.id) {
    throw currentInvalid("Workstream current request must name its one active request.", {
      currentRequest: card.currentRequest,
    });
  }
  return current;
}

function requireTracked(tracked: ReadonlySet<string>, path: string): void {
  if (!tracked.has(path)) {
    throw invalidRepository("Workstream is missing a required context file.", { path });
  }
}

async function committedFile(repositoryPath: string, path: string): Promise<string> {
  return await runGitRaw(["show", "HEAD:" + path], { cwd: repositoryPath });
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  return await runGit(args, { cwd: repositoryPath });
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function currentInvalid(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}

function invalidRepository(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
