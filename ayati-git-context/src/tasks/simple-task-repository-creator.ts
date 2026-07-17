import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import {
  configureAyatiGitIdentity,
  gitCommitEnvironment,
  runGit,
  runGitRaw,
} from "../git/git-process.js";
import type { TaskInitializationRecord } from "../repositories/task-records.js";
import { renderTaskCard } from "./task-card.js";
import {
  parseSimpleTaskCommit,
  renderTaskIdentityCommit,
} from "./task-commit-metadata.js";
import { renderTaskReferences } from "./task-references.js";
import {
  requestFileName,
  TASK_CARD_PATH,
  TASK_INBOX_KEEP_PATH,
  TASK_REFERENCES_PATH,
} from "./task-repository-layout.js";
import { validateTaskRepository } from "./task-repository-validator.js";
import { renderTaskRequest } from "./task-request.js";

export type SimpleTaskCreationPhase =
  | "allocated"
  | "directory_created"
  | "git_initialized"
  | "scaffold_written"
  | "identity_committed"
  | "repository_validated"
  | "catalog_activated";

export type SimpleTaskCreationHook = (
  phase: SimpleTaskCreationPhase,
  task: TaskInitializationRecord,
) => void | Promise<void>;

const INITIAL_REQUEST_ID = "R-0001";
const CREATION_MARKER_PATH = ".ayati-creation";
const GITIGNORE = [
  "# Ayati local input bytes. Durable provenance lives in .ayati/references.md.",
  ".ayati/inbox/*",
  "!.ayati/inbox/.gitkeep",
  "",
].join("\n");

export async function ensureSimpleTaskRepository(input: {
  task: TaskInitializationRecord;
  taskRoot: string;
  recovering: boolean;
  onPhase?: SimpleTaskCreationHook;
}): Promise<string> {
  try {
    return await ensureRepository(input);
  } catch (error) {
    if (error instanceof GitContextServiceError) throw error;
    throw new GitContextServiceError({
      code: "REPOSITORY_UNAVAILABLE",
      message: "V1 task repository could not be initialized or recovered.",
      retryable: true,
      details: {
        taskId: input.task.taskId,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function ensureRepository(input: {
  task: TaskInitializationRecord;
  taskRoot: string;
  recovering: boolean;
  onPhase?: SimpleTaskCreationHook;
}): Promise<string> {
  requireV1Record(input.task);
  await mkdir(input.taskRoot, { recursive: true });
  const taskRoot = await realpath(input.taskRoot);
  const target = resolve(input.task.repositoryPath);
  if (dirname(target) !== taskRoot
    || input.task.workingPath !== input.task.repositoryPath
    || !basename(target).startsWith(input.task.taskId + "-")) {
    throw invalidRepository(input.task, "V1 task allocation is outside its configured task root.");
  }
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    await mkdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw ambiguousRepository(input.task, [basename(target)]);
      }
      throw error;
    });
    await writeFileAtomically(join(target, CREATION_MARKER_PATH), creationMarker(input.task));
    await input.onPhase?.("directory_created", input.task);
  } else if (!input.recovering) {
    throw ambiguousRepository(input.task, [basename(target)]);
  } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw invalidRepository(input.task, "V1 task path must be a normal directory.");
  }
  const repositoryPath = await realpath(target);
  if (dirname(repositoryPath) !== taskRoot) {
    throw invalidRepository(input.task, "V1 task directory does not resolve beneath its task root.");
  }
  const scaffold = renderScaffold(input.task);
  if (existing) {
    await requireRecoveryEvidence(input.task, repositoryPath);
  }

  const gitPath = join(repositoryPath, ".git");
  const gitState = await lstat(gitPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!gitState) {
    const entries = await readdir(repositoryPath);
    if (entries.length !== 1 || entries[0] !== CREATION_MARKER_PATH) {
      throw ambiguousRepository(input.task, entries);
    }
    await runGit(["init", "--initial-branch=" + input.task.branch], { cwd: repositoryPath });
    await input.onPhase?.("git_initialized", input.task);
  } else if (gitState.isSymbolicLink() || !gitState.isDirectory()) {
    throw invalidRepository(input.task, "V1 task .git path must be a normal directory.");
  }

  await verifyRepositoryShell(input.task, repositoryPath);
  await configureAyatiGitIdentity(repositoryPath);
  const head = await readHead(repositoryPath);
  if (!head) {
    await verifyRecoverableContent(input.task, repositoryPath, scaffold);
    await writeMissingScaffold(repositoryPath, scaffold);
    await input.onPhase?.("scaffold_written", input.task);
    const paths = [...scaffold.keys()].sort();
    await runGit(["add", "--", ...paths], { cwd: repositoryPath });
    const staged = (await runGit(["diff", "--cached", "--name-only"], {
      cwd: repositoryPath,
    })).split("\n").filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify(paths)) {
      throw ambiguousRepository(input.task, staged);
    }
    await runGit(["commit", "-m", renderTaskIdentityCommit({
      subject: "create task " + input.task.taskId.toLowerCase(),
      taskId: input.task.taskId,
      requestId: INITIAL_REQUEST_ID,
    })], {
      cwd: repositoryPath,
      env: gitCommitEnvironment(input.task.createdAt),
    });
    await input.onPhase?.("identity_committed", input.task);
  }

  const validation = await validateTaskRepository({
    taskRoot,
    repositoryPath,
    expectedTaskId: input.task.taskId,
  });
  await verifyIdentityCommit(input.task, repositoryPath, validation.head);
  const expectedCreationDirt = ["?? " + CREATION_MARKER_PATH];
  if (validation.branch !== input.task.branch
    || JSON.stringify(validation.workingTreeChanges) !== JSON.stringify(expectedCreationDirt)) {
    throw invalidRepository(input.task, "Created V1 task repository is not clean on its durable branch.");
  }
  await input.onPhase?.("repository_validated", input.task);
  return validation.head;
}

function renderScaffold(task: TaskInitializationRecord): Map<string, string> {
  const requestPath = ".ayati/requests/" + requestFileName(INITIAL_REQUEST_ID, task.title);
  return new Map([
    [".gitignore", GITIGNORE],
    [TASK_CARD_PATH, renderTaskCard({
      schema: "ayati.task/v1",
      id: task.taskId,
      title: task.title,
      status: "active",
      currentRequest: INITIAL_REQUEST_ID,
      purpose: task.objective,
      currentSnapshot: "The task repository is initialized; no request work is complete yet.",
      currentFocus: "Complete the initial request and record verified outcomes.",
      blockers: [],
      importantPaths: [],
      workingAgreements: [
        "Keep durable context and verified outcomes in Git.",
        "Keep secrets and local attachment bytes out of Git.",
      ],
    })],
    [requestPath, renderTaskRequest({
      schema: "ayati.request/v1",
      id: INITIAL_REQUEST_ID,
      title: task.title,
      status: "active",
      createdAt: task.createdAt,
      source: "user",
      request: task.objective,
      acceptance: ["The initial task objective is completed and deterministically verified."],
      constraints: [],
      outcome: "Not completed yet.",
    })],
    [TASK_REFERENCES_PATH, renderTaskReferences([])],
    [TASK_INBOX_KEEP_PATH, ""],
  ]);
}

async function verifyRecoverableContent(
  task: TaskInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
  const allowed = new Set([
    CREATION_MARKER_PATH,
    ".ayati",
    ".ayati/inbox",
    ".ayati/requests",
    ...scaffold.keys(),
  ]);
  const content = await listContent(repositoryPath);
  const unexpected = content.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) throw ambiguousRepository(task, unexpected);
  for (const [path, expected] of scaffold) {
    const actual = await readFile(join(repositoryPath, path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (actual !== undefined && actual !== expected) {
      throw ambiguousRepository(task, [path]);
    }
  }
}

async function requireRecoveryEvidence(
  task: TaskInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  const markerPath = join(repositoryPath, CREATION_MARKER_PATH);
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (marker?.isFile()
    && await readFile(markerPath, "utf8") === creationMarker(task)) {
    return;
  }
  throw ambiguousRepository(task, await readdir(repositoryPath));
}

export async function completeSimpleTaskCreation(
  task: TaskInitializationRecord,
): Promise<void> {
  const markerPath = join(task.repositoryPath, CREATION_MARKER_PATH);
  const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!marker) return;
  if (!marker.isFile() || await readFile(markerPath, "utf8") !== creationMarker(task)) {
    throw ambiguousRepository(task, [CREATION_MARKER_PATH]);
  }
  await rm(markerPath);
}

async function writeMissingScaffold(
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [path, content] of scaffold) {
    const exists = await lstat(join(repositoryPath, path)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!exists) await writeFileAtomically(join(repositoryPath, path), content);
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
        throw new GitContextServiceError({
          code: "RECOVERY_REQUIRED",
          message: "Initializing V1 task contains a non-file entry.",
          details: { repositoryPath, path },
        });
      }
    }
  }
  await visit("");
  return result.sort();
}

async function verifyRepositoryShell(
  task: TaskInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  const topLevel = resolve(await runGit(["rev-parse", "--show-toplevel"], {
    cwd: repositoryPath,
  }));
  const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: repositoryPath });
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repositoryPath });
  if (topLevel !== resolve(repositoryPath) || bare !== "false" || branch !== task.branch) {
    throw invalidRepository(task, "V1 task Git identity does not match its catalog allocation.");
  }
}

async function verifyIdentityCommit(
  task: TaskInitializationRecord,
  repositoryPath: string,
  head: string,
): Promise<void> {
  const count = await runGit(["rev-list", "--count", head], { cwd: repositoryPath });
  const message = await runGitRaw(["log", "-1", "--format=%B", head], {
    cwd: repositoryPath,
  });
  const metadata = parseSimpleTaskCommit(message);
  if (count !== "1"
    || metadata?.event !== "task_created"
    || metadata.taskId !== task.taskId
    || metadata.requestId !== INITIAL_REQUEST_ID) {
    throw invalidRepository(task, "V1 task identity commit does not match its catalog allocation.");
  }
}

async function readHead(repositoryPath: string): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath });
  } catch {
    return undefined;
  }
}

function requireV1Record(task: TaskInitializationRecord): void {
  if (task.layoutVersion !== "simple_repository_v1") {
    throw invalidRepository(task, "Simple repository creator received a legacy task record.");
  }
}

function creationMarker(task: TaskInitializationRecord): string {
  return [
    "ayati.simple-task-creation/v1",
    task.taskId,
    task.createdAt,
    "",
  ].join("\n");
}

function invalidRepository(task: TaskInitializationRecord, message: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_REPOSITORY_INVALID",
    message,
    details: { taskId: task.taskId, repositoryPath: task.repositoryPath },
  });
}

function ambiguousRepository(
  task: TaskInitializationRecord,
  paths: readonly string[],
): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message: "Initializing V1 task contains ambiguous content and was preserved unchanged.",
    details: {
      taskId: task.taskId,
      repositoryPath: task.repositoryPath,
      unexpectedPaths: [...paths].sort(),
    },
  });
}
