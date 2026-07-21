import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContextEngineServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import {
  configureAyatiGitIdentity,
  gitCommitEnvironment,
  runGit,
  runGitRaw,
} from "../git/git-process.js";
import type { WorkstreamInitializationRecord } from "../repositories/workstream-records.js";
import { renderWorkstreamCard } from "./workstream-card.js";
import {
  parseWorkstreamCommit,
  renderWorkstreamIdentityCommit,
} from "./workstream-commit-metadata.js";
import {
  requestPath,
  WORKSTREAM_CARD_PATH,
  WORKSTREAM_RESOURCES_PATH,
} from "./workstream-repository-layout.js";
import {
  renderWorkstreamResourceManifest,
  WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
} from "./workstream-resource-manifest.js";
import { validateWorkstreamRepository } from "./workstream-repository-validator.js";
import { renderWorkstreamRequest } from "./workstream-request.js";

export type SimpleWorkstreamCreationPhase =
  | "allocated"
  | "directory_created"
  | "git_initialized"
  | "scaffold_written"
  | "identity_committed"
  | "repository_validated"
  | "catalog_activated";

export type SimpleWorkstreamCreationHook = (
  phase: SimpleWorkstreamCreationPhase,
  workstream: WorkstreamInitializationRecord,
) => void | Promise<void>;

const INITIAL_REQUEST_ID = "R-0001";
const CREATION_MARKER_PATH = ".ayati-creation";

export async function ensureSimpleWorkstreamRepository(input: {
  workstream: WorkstreamInitializationRecord;
  workstreamRoot: string;
  recovering: boolean;
  onPhase?: SimpleWorkstreamCreationHook;
}): Promise<string> {
  try {
    return await ensureRepository(input);
  } catch (error) {
    if (error instanceof ContextEngineServiceError) throw error;
    throw new ContextEngineServiceError({
      code: "REPOSITORY_UNAVAILABLE",
      message: "Workstream context repository could not be initialized or recovered.",
      retryable: true,
      details: {
        workstreamId: input.workstream.workstreamId,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function ensureRepository(input: {
  workstream: WorkstreamInitializationRecord;
  workstreamRoot: string;
  recovering: boolean;
  onPhase?: SimpleWorkstreamCreationHook;
}): Promise<string> {
  await mkdir(input.workstreamRoot, { recursive: true });
  const workstreamRoot = await realpath(input.workstreamRoot);
  const target = resolve(input.workstream.contextRepositoryPath);
  if (dirname(target) !== workstreamRoot
    || !basename(target).startsWith(input.workstream.workstreamId + "-")) {
    throw invalidRepository(
      input.workstream,
      "Workstream context repository allocation is outside its configured root.",
    );
  }

  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    await mkdir(target);
    await writeFileAtomically(join(target, CREATION_MARKER_PATH), creationMarker(input.workstream));
    await input.onPhase?.("directory_created", input.workstream);
  } else if (!input.recovering) {
    throw ambiguousRepository(input.workstream, await readdir(target));
  } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw invalidRepository(input.workstream, "Workstream context repository must be a normal directory.");
  }

  const repositoryPath = await realpath(target);
  if (dirname(repositoryPath) !== workstreamRoot) {
    throw invalidRepository(
      input.workstream,
      "Workstream context repository does not resolve beneath its configured root.",
    );
  }
  await requireRecoveryEvidence(input.workstream, repositoryPath);

  const scaffold = renderScaffold(input.workstream);
  await verifyRecoverableContent(input.workstream, repositoryPath, scaffold);
  const gitState = await lstat(join(repositoryPath, ".git")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!gitState) {
    await runGit(["init", "--initial-branch=" + input.workstream.branch], { cwd: repositoryPath });
    await input.onPhase?.("git_initialized", input.workstream);
  } else if (gitState.isSymbolicLink() || !gitState.isDirectory()) {
    throw invalidRepository(input.workstream, "Workstream context .git path must be a normal directory.");
  }

  await verifyRepositoryShell(input.workstream, repositoryPath);
  await configureAyatiGitIdentity(repositoryPath);
  const head = await readHead(repositoryPath);
  if (head) {
    await verifyIdentityCommit(input.workstream, repositoryPath, head);
  } else {
    await writeScaffold(repositoryPath, scaffold);
    await input.onPhase?.("scaffold_written", input.workstream);
    const paths = [...scaffold.keys()].sort();
    await runGit(["add", "--", ...paths], { cwd: repositoryPath });
    const staged = (await runGit(["diff", "--cached", "--name-only"], { cwd: repositoryPath }))
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(staged) !== JSON.stringify(paths)) {
      throw ambiguousRepository(input.workstream, staged);
    }
    await runGit([
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      renderWorkstreamIdentityCommit({
        subject: "create workstream " + input.workstream.workstreamId.toLowerCase(),
        workstreamId: input.workstream.workstreamId,
        requestId: INITIAL_REQUEST_ID,
      }),
    ], {
      cwd: repositoryPath,
      env: gitCommitEnvironment(input.workstream.createdAt),
    });
    await input.onPhase?.("identity_committed", input.workstream);
  }

  const validation = await validateWorkstreamRepository({
    workstreamRoot,
    contextRepositoryPath: repositoryPath,
    expectedWorkstreamId: input.workstream.workstreamId,
  });
  await verifyIdentityCommit(input.workstream, repositoryPath, validation.head);
  const expectedCreationDirt = ["?? " + CREATION_MARKER_PATH];
  if (validation.branch !== input.workstream.branch
    || JSON.stringify(validation.workingTreeChanges) !== JSON.stringify(expectedCreationDirt)) {
    throw invalidRepository(
      input.workstream,
      "Created workstream context repository has unexpected working-tree changes.",
    );
  }
  await input.onPhase?.("repository_validated", input.workstream);
  return validation.head;
}

function renderScaffold(workstream: WorkstreamInitializationRecord): Map<string, string> {
  const initialRequest = workstream.initialRequest ?? {
    title: workstream.title,
    request: workstream.objective,
    acceptance: ["The initial workstream objective is completed and deterministically verified."],
    constraints: [],
  };
  return new Map([
    [WORKSTREAM_CARD_PATH, renderWorkstreamCard({
      schema: "ayati.workstream/v2",
      id: workstream.workstreamId,
      title: workstream.title,
      status: "active",
      currentRequest: INITIAL_REQUEST_ID,
      purpose: workstream.objective,
      currentSnapshot: "The workstream is initialized; no request work is complete yet.",
      currentFocus: "Complete the initial request and record verified outcomes.",
      blockers: [],
      workingAgreements: [
        "Keep durable context and verified outcomes in this repository.",
        "Keep deliverables, user files, secrets, and attachment bytes outside this repository.",
        "Represent external work through resource identities and verified resource events.",
      ],
    })],
    [requestPath(INITIAL_REQUEST_ID, initialRequest.title), renderWorkstreamRequest({
      schema: "ayati.request/v2",
      id: INITIAL_REQUEST_ID,
      title: initialRequest.title,
      status: "active",
      createdAt: workstream.createdAt,
      source: "user",
      request: initialRequest.request,
      acceptance: initialRequest.acceptance,
      constraints: initialRequest.constraints,
      outcome: "Not completed yet.",
    })],
    [WORKSTREAM_RESOURCES_PATH, renderWorkstreamResourceManifest({
      schema: WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
      workstreamId: workstream.workstreamId,
      updatedAt: workstream.createdAt,
      resources: [],
    })],
  ]);
}

async function verifyRecoverableContent(
  workstream: WorkstreamInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
  const allowed = new Set([
    CREATION_MARKER_PATH,
    "requests",
    ...scaffold.keys(),
  ]);
  const content = await listContent(repositoryPath);
  const unexpected = content.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) throw ambiguousRepository(workstream, unexpected);
  for (const [path, expected] of scaffold) {
    const actual = await readFile(join(repositoryPath, path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (actual !== undefined && actual !== expected) {
      throw ambiguousRepository(workstream, [path]);
    }
  }
}

async function requireRecoveryEvidence(
  workstream: WorkstreamInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  const markerPath = join(repositoryPath, CREATION_MARKER_PATH);
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (marker?.isFile()
    && await readFile(markerPath, "utf8") === creationMarker(workstream)) {
    return;
  }
  throw ambiguousRepository(workstream, await readdir(repositoryPath));
}

export async function completeSimpleWorkstreamCreation(
  workstream: WorkstreamInitializationRecord,
): Promise<void> {
  const markerPath = join(workstream.contextRepositoryPath, CREATION_MARKER_PATH);
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!marker) return;
  if (!marker.isFile() || await readFile(markerPath, "utf8") !== creationMarker(workstream)) {
    throw ambiguousRepository(workstream, [CREATION_MARKER_PATH]);
  }
  await rm(markerPath);
}

async function writeScaffold(
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, expected] of scaffold) {
    const current = await readFile(join(repositoryPath, path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (current === undefined) {
      await writeFileAtomically(join(repositoryPath, path), expected);
    } else if (current !== expected) {
      throw new Error("Scaffold changed while initializing: " + path);
    }
  }
}

async function listContent(repositoryPath: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(relativePath: string): Promise<void> {
    const directory = join(repositoryPath, relativePath);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relativePath ? relativePath + "/" + entry.name : entry.name;
      if (path === ".git") continue;
      result.push(path);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (!entry.isFile()) {
        throw new ContextEngineServiceError({
          code: "RECOVERY_REQUIRED",
          message: "Initializing workstream context contains a non-file entry.",
          details: { repositoryPath, path },
        });
      }
    }
  }
  await visit("");
  return result.sort();
}

async function verifyRepositoryShell(
  workstream: WorkstreamInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  const topLevel = resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath }));
  const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: repositoryPath });
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repositoryPath });
  if (topLevel !== resolve(repositoryPath) || bare !== "false" || branch !== workstream.branch) {
    throw invalidRepository(
      workstream,
      "Workstream context Git identity does not match its catalog allocation.",
    );
  }
}

async function verifyIdentityCommit(
  workstream: WorkstreamInitializationRecord,
  repositoryPath: string,
  head: string,
): Promise<void> {
  const count = await runGit(["rev-list", "--count", head], { cwd: repositoryPath });
  const message = await runGitRaw(["log", "-1", "--format=%B", head], { cwd: repositoryPath });
  const metadata = parseWorkstreamCommit(message);
  if (count !== "1"
    || metadata?.event !== "workstream_created"
    || metadata.workstreamId !== workstream.workstreamId
    || metadata.requestId !== INITIAL_REQUEST_ID) {
    throw invalidRepository(
      workstream,
      "Workstream identity commit does not match its catalog allocation.",
    );
  }
}

async function readHead(repositoryPath: string): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath });
  } catch {
    return undefined;
  }
}

function creationMarker(workstream: WorkstreamInitializationRecord): string {
  return [
    "ayati.workstream-context-creation/v1",
    workstream.workstreamId,
    workstream.createdAt,
    "",
  ].join("\n");
}

function invalidRepository(
  workstream: WorkstreamInitializationRecord,
  message: string,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    details: {
      workstreamId: workstream.workstreamId,
      contextRepositoryPath: workstream.contextRepositoryPath,
    },
  });
}

function ambiguousRepository(
  workstream: WorkstreamInitializationRecord,
  paths: readonly string[],
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "RECOVERY_REQUIRED",
    message: "Initializing workstream context contains ambiguous content and was preserved unchanged.",
    details: {
      workstreamId: workstream.workstreamId,
      contextRepositoryPath: workstream.contextRepositoryPath,
      unexpectedPaths: [...paths].sort(),
    },
  });
}
