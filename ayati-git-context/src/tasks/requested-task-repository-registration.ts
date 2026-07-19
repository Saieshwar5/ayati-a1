import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import type { TaskInitializationRecord } from "../repositories/task-records.js";

export async function assertRequestedTaskNamespaceAvailable(
  workspaceRoot: string,
  repositoryPath: string,
): Promise<void> {
  const managedTaskRoot = resolve(workspaceRoot, "tasks");
  if (isWithinPath(managedTaskRoot, repositoryPath)) {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task directories cannot use the reserved managed task root.",
      details: { repositoryPath, managedTaskRoot },
    });
  }
  const reserved = await lstat(join(repositoryPath, ".ayati")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (reserved) {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task directory already contains the reserved .ayati namespace.",
      details: { repositoryPath },
    });
  }
}

export async function validateRequestedTaskLocation(
  task: TaskInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  const trustedRoot = await realpath(task.trustedRoot).catch(() => undefined);
  if (!trustedRoot
    || resolve(task.repositoryPath) !== repositoryPath
    || task.workingPath !== task.repositoryPath
    || !isWithinPath(trustedRoot, repositoryPath)) {
    throw invalidRepository(task, "Requested task directory is outside its recorded trusted root.");
  }
}

export async function assertRequestedTaskStartingState(
  task: TaskInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
  creationMarkerPath: string,
): Promise<void> {
  const marker = await lstat(join(repositoryPath, creationMarkerPath)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (marker) throw ambiguousRepository(task, [creationMarkerPath]);
  await assertReservedScaffoldAvailable(task, repositoryPath, scaffold);
  if (task.registrationWasGit) {
    await verifyRequestedGitShell(task, repositoryPath);
    const head = await readHead(repositoryPath);
    const changes = await readWorkingTreeChanges(repositoryPath);
    if (head !== task.registrationHeadBefore || changes.length > 0) {
      throw invalidRepository(task, "Requested Git repository changed after its clean inspection.");
    }
    return;
  }
  const gitPath = await lstat(join(repositoryPath, ".git")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (gitPath) {
    throw invalidRepository(task, "Requested non-Git directory gained Git state before registration.");
  }
  if (task.registrationApprovalId) {
    await verifyRequestedTaskBaseline(task, repositoryPath);
    return;
  }
  const entries = await readdir(repositoryPath);
  if (entries.length > 0) throw ambiguousRepository(task, entries);
}

export async function verifyRequestedTaskScaffoldCompatibility(
  task: TaskInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
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

export async function verifyRequestedTaskBaseline(
  task: TaskInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  if (!task.registrationApprovalId) return;
  const digest = createHash("sha256");
  for (const path of task.baselinePaths) {
    const absolute = resolve(repositoryPath, path);
    if (!isWithinPath(repositoryPath, absolute)) {
      throw invalidRepository(task, "Registration baseline contains an unsafe path.");
    }
    const metadata = await lstat(absolute).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw ambiguousRepository(task, [path]);
    }
    const bytes = await readFile(absolute);
    digest.update(path).update("\0").update(String(metadata.size)).update("\0").update(bytes);
  }
  const actual = "sha256:" + digest.digest("hex");
  if (!task.registrationSnapshotHash || actual !== task.registrationSnapshotHash) {
    throw invalidRepository(task, "Approved directory content changed before registration.");
  }
}

export async function writeRequestedTaskRegistrationExcludes(
  task: TaskInitializationRecord,
  repositoryPath: string,
): Promise<void> {
  if (task.placement !== "requested" || task.registrationExcludedPaths.length === 0) return;
  const path = join(repositoryPath, ".git", "info", "exclude");
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const header = `# Ayati registration exclusions for ${task.taskId}`;
  const block = [
    header,
    ...task.registrationExcludedPaths.map(renderExcludePattern),
    `# End Ayati registration exclusions for ${task.taskId}`,
  ].join("\n") + "\n";
  if (current.includes(header)) {
    if (!current.includes(block)) throw ambiguousRepository(task, [".git/info/exclude"]);
    return;
  }
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await writeFileAtomically(path, current + separator + block);
}

export async function verifyOnlyRequestedTaskRegistrationChanges(
  task: TaskInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
  creationMarkerPath: string,
): Promise<void> {
  const allowed = new Set([
    "?? " + creationMarkerPath,
    ...task.baselinePaths.map((path) => "?? " + path),
    ...[...scaffold.keys()].map((path) => "?? " + path),
  ]);
  const changes = await readWorkingTreeChanges(repositoryPath);
  const unexpected = changes.filter((change) => !allowed.has(change));
  if (unexpected.length > 0) {
    throw invalidRepository(task, "Requested Git repository changed during task registration.");
  }
}

async function assertReservedScaffoldAvailable(
  task: TaskInitializationRecord,
  repositoryPath: string,
  scaffold: ReadonlyMap<string, string>,
): Promise<void> {
  const conflicts: string[] = [];
  for (const path of scaffold.keys()) {
    if (await lstat(join(repositoryPath, path)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) conflicts.push(path);
  }
  if (conflicts.length > 0) throw ambiguousRepository(task, conflicts);
}

async function verifyRequestedGitShell(
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

async function readWorkingTreeChanges(repositoryPath: string): Promise<string[]> {
  return (await runGitRaw(["status", "--porcelain", "--untracked-files=all"], {
    cwd: repositoryPath,
  })).replaceAll("\r\n", "\n").trimEnd().split("\n").filter(Boolean);
}

async function readHead(repositoryPath: string): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath });
  } catch {
    return undefined;
  }
}

function renderExcludePattern(path: string): string {
  const directory = path.endsWith("/");
  const plain = directory ? path.slice(0, -1) : path;
  const escaped = plain.replace(/[\\*?\[\]#!]/g, "\\$&").replace(/ /g, "\\ ");
  return "/" + escaped + (directory ? "/" : "");
}

function isWithinPath(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
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
