import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ContextEngineServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { parseWorkstreamCard, type WorkstreamCard } from "./workstream-card.js";
import {
  isRequestId,
  requestFileName,
  WORKSTREAM_CARD_PATH,
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
  branch: string;
  head: string;
  health: WorkstreamRepositoryHealth;
  workstreamCard: WorkstreamCard;
  currentRequest?: WorkstreamRequest;
  requests: WorkstreamRequest[];
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
    throw invalidRepository("Workstream context repository validation failed.", {
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
  const root = await realpath(input.workstreamRoot).catch((error: NodeJS.ErrnoException) => {
    throw invalidRepository("Configured workstream root is unavailable.", {
      workstreamRoot: input.workstreamRoot,
      cause: error.message,
    });
  });
  const stat = await lstat(input.contextRepositoryPath).catch((error: NodeJS.ErrnoException) => {
    throw invalidRepository("Workstream context repository is unavailable.", {
      contextRepositoryPath: input.contextRepositoryPath,
      health: "missing",
      cause: error.message,
    });
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalidRepository("Workstream context repository must be a normal directory.", {
      contextRepositoryPath: input.contextRepositoryPath,
    });
  }
  const contextRepositoryPath = await realpath(input.contextRepositoryPath);
  if (dirname(contextRepositoryPath) !== root) {
    throw invalidRepository("Workstream context repository must be a direct child of its root.", {
      workstreamRoot: root,
      contextRepositoryPath,
    });
  }
  const gitRoot = resolve(await git(contextRepositoryPath, ["rev-parse", "--show-toplevel"]));
  if (gitRoot !== resolve(contextRepositoryPath)) {
    throw invalidRepository("Workstream context directory is not the exact Git repository root.", {
      contextRepositoryPath,
      gitRoot,
    });
  }
  if (await git(contextRepositoryPath, ["rev-parse", "--is-bare-repository"]) !== "false") {
    throw invalidRepository("Workstream context repository must be non-bare.", {
      contextRepositoryPath,
    });
  }
  const head = await git(contextRepositoryPath, ["rev-parse", "HEAD"]);
  const branch = await git(contextRepositoryPath, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") {
    throw invalidRepository("Workstream context repository must use its attached main branch.", {
      contextRepositoryPath,
      branch,
    });
  }

  const trackedPaths = (await git(contextRepositoryPath, ["ls-tree", "-r", "--name-only", "HEAD"]))
    .split("\n")
    .filter(Boolean);
  const tracked = new Set(trackedPaths);
  requireTracked(tracked, WORKSTREAM_CARD_PATH);
  requireTracked(tracked, WORKSTREAM_RESOURCES_PATH);
  const unexpected = trackedPaths.filter((path) => path !== WORKSTREAM_CARD_PATH
    && path !== WORKSTREAM_RESOURCES_PATH
    && !path.startsWith(WORKSTREAM_REQUESTS_DIRECTORY + "/"));
  if (unexpected.length > 0) {
    throw invalidRepository("Workstream context repository contains non-context tracked paths.", {
      unexpectedPaths: unexpected,
    });
  }

  const workstreamCard = parseWorkstreamCard(
    await committedFile(contextRepositoryPath, WORKSTREAM_CARD_PATH),
    input.expectedWorkstreamId,
  );
  if (!basename(contextRepositoryPath).startsWith(workstreamCard.id + "-")) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_ID_MISMATCH",
      message: "Workstream context directory does not begin with its workstream identity.",
      details: { workstreamId: workstreamCard.id, contextRepositoryPath },
    });
  }
  const requestPaths = trackedPaths.filter(
    (path) => path.startsWith(WORKSTREAM_REQUESTS_DIRECTORY + "/"),
  );
  validateRequestPaths(requestPaths);
  const requests = input.requestReadMode === "current"
    ? await readCurrentRequest(contextRepositoryPath, requestPaths, workstreamCard)
    : await readRequests(contextRepositoryPath, requestPaths);
  const currentRequest = input.requestReadMode === "current"
    ? requests[0]
    : validateCurrentRequest(workstreamCard, requests);
  const resourceManifest = parseWorkstreamResourceManifest(
    await committedFile(contextRepositoryPath, WORKSTREAM_RESOURCES_PATH),
    workstreamCard.id,
  );

  const statusOutput = await runGitRaw([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], { cwd: contextRepositoryPath });
  const workingTreeChanges = statusOutput
    .replaceAll("\r\n", "\n")
    .replace(/\n$/, "")
    .split("\n")
    .filter(Boolean);
  return {
    workstreamId: workstreamCard.id,
    contextRepositoryPath,
    branch,
    head,
    health: workingTreeChanges.length > 0 ? "dirty_external" : "ready",
    workstreamCard,
    ...(currentRequest ? { currentRequest } : {}),
    requests,
    resourceManifest,
    workingTreeChanges,
  };
}

async function readRequests(contextRepositoryPath: string, paths: string[]): Promise<WorkstreamRequest[]> {
  const requests: WorkstreamRequest[] = [];
  const ids = new Set<string>();
  for (const path of paths) {
    const name = basename(path);
    const id = name.slice(0, 6);
    if (!/^R-\d{4}-.+\.md$/.test(name) || !isRequestId(id)) {
      throw invalidRepository("Workstream request directory contains an invalid tracked path.", { path });
    }
    const request = parseWorkstreamRequest(await committedFile(contextRepositoryPath, path), id);
    if (requestFileName(request.id, request.title) !== name) {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_REQUEST_INVALID",
        message: "Workstream request filename does not match its identity and title.",
        details: { path, requestId: request.id },
      });
    }
    if (ids.has(request.id)) {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_REQUEST_INVALID",
        message: "Workstream repository contains duplicate request identities.",
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
      throw invalidRepository("Workstream request directory contains an invalid tracked path.", { path });
    }
    if (ids.has(id)) {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_REQUEST_INVALID",
        message: "Workstream repository contains duplicate request identities.",
        details: { requestId: id },
      });
    }
    ids.add(id);
  }
}

async function readCurrentRequest(
  contextRepositoryPath: string,
  paths: string[],
  workstreamCard: WorkstreamCard,
): Promise<WorkstreamRequest[]> {
  if (!workstreamCard.currentRequest) return [];
  const matches = paths.filter((path) => basename(path).startsWith(workstreamCard.currentRequest + "-"));
  if (matches.length !== 1 || !matches[0]) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "Workstream card current request must have exactly one committed request file.",
      details: { currentRequest: workstreamCard.currentRequest },
    });
  }
  const request = parseWorkstreamRequest(
    await committedFile(contextRepositoryPath, matches[0]),
    workstreamCard.currentRequest,
  );
  if (request.status !== "active" || workstreamCard.status !== "active") {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "The current request and workstream must both be active.",
      details: { currentRequest: workstreamCard.currentRequest, requestStatus: request.status },
    });
  }
  if (requestFileName(request.id, request.title) !== basename(matches[0])) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Workstream request filename does not match its identity and title.",
      details: { path: matches[0], requestId: request.id },
    });
  }
  return [request];
}

function validateCurrentRequest(
  workstreamCard: WorkstreamCard,
  requests: WorkstreamRequest[],
): WorkstreamRequest | undefined {
  const active = requests.filter((request) => request.status === "active");
  if (workstreamCard.status !== "active" && active.length > 0) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "Paused or archived workstreams cannot contain an active request.",
      details: { workstreamStatus: workstreamCard.status, activeRequestId: active[0]?.id },
    });
  }
  if (active.length > 1) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "Workstream repository may contain at most one active request.",
      details: { activeRequestIds: active.map((request) => request.id) },
    });
  }
  if (!workstreamCard.currentRequest) {
    if (active.length > 0) {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
        message: "Workstream card has no current request but an active request exists.",
        details: { activeRequestId: active[0]?.id },
      });
    }
    return undefined;
  }
  const current = requests.find((request) => request.id === workstreamCard.currentRequest);
  if (!current || current.status !== "active" || active[0]?.id !== current.id) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
      message: "Workstream card current request must name the repository's one active request.",
      details: { currentRequest: workstreamCard.currentRequest },
    });
  }
  return current;
}

function requireTracked(tracked: ReadonlySet<string>, path: string): void {
  if (!tracked.has(path)) {
    throw invalidRepository("Workstream context repository is missing a required tracked file.", { path });
  }
}

async function committedFile(contextRepositoryPath: string, path: string): Promise<string> {
  return await runGitRaw(["show", "HEAD:" + path], { cwd: contextRepositoryPath });
}

async function git(contextRepositoryPath: string, args: string[]): Promise<string> {
  return await runGit(args, { cwd: contextRepositoryPath });
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
