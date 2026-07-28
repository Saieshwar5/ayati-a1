import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ContextEngineServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import type { WorkstreamContextCommitPlan } from "../repositories/workstream-finalization-records.js";
import { WORKSTREAM_PROGRESS_PATH } from "../workstreams/workstream-repository-layout.js";
import { gitCommitEnvironment, runGit } from "./git-process.js";

export async function commitWorkstreamContextPlan(input: {
  contextRepositoryPath: string;
  branch: string;
  /** Expected global shared-repository HEAD. */
  baseHead: string;
  plan: WorkstreamContextCommitPlan;
  at: string;
}): Promise<{ head: string; created: boolean }> {
  const paths = sharedPaths(input.contextRepositoryPath, input.plan);
  const current = await readIdentity(paths.repositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("Shared workstream branch changed during finalization.", input, current.branch);
  }
  if (current.head !== input.baseHead) {
    const recognized = await recognizeCommittedWorkstreamContextPlan(input);
    if (recognized) return { head: recognized, created: true };
    throw mismatch("Shared workstream HEAD changed during finalization.", input, current.head);
  }
  if (!input.plan.commitRequired) {
    await requireCleanTree(paths.repositoryPath);
    return { head: input.baseHead, created: false };
  }

  await requireCleanOrJournaledTree(paths.repositoryPath, paths.staged);
  for (const write of input.plan.contextWrites) {
    requireContextPath(write.path);
    const target = join(input.contextRepositoryPath, write.path);
    const actual = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const before = input.plan.contextBefore.find((entry) => entry.path === write.path);
    const actualHash = actual === undefined ? "missing" : contentHash(actual);
    const desiredHash = contentHash(write.content);
    if (!before || (actualHash !== before.sha256 && actualHash !== desiredHash)) {
      throw recovery("Engine-owned workstream context changed after planning.", {
        path: write.path,
      });
    }
    await writeFileAtomically(target, write.content);
    if (await readFile(target, "utf8") !== write.content) {
      throw recovery("Rendered workstream context could not be verified.", {
        path: write.path,
      });
    }
  }
  await runGit(["add", "-A", "--", ...paths.staged], { cwd: paths.repositoryPath });
  const staged = lines(await runGit([
    "diff",
    "--cached",
    "--name-only",
    "--",
  ], { cwd: paths.repositoryPath })).sort();
  if (JSON.stringify(staged) !== JSON.stringify(paths.staged)) {
    throw recovery("Finalization staged paths do not match its shared-repository plan.", {
      expectedPaths: paths.staged,
      actualPaths: staged,
    });
  }
  const unstaged = lines(await runGit(["diff", "--name-only", "--"], {
    cwd: paths.repositoryPath,
  })).sort();
  const untracked = lines(await runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
  ], { cwd: paths.repositoryPath })).sort();
  if (unstaged.length > 0 || untracked.length > 0) {
    throw recovery("Shared workstream repository contains changes outside the plan.", {
      unstagedPaths: unstaged,
      untrackedPaths: untracked,
    });
  }
  if (staged.length === 0) {
    throw recovery("Finalization refused to create an empty context commit.");
  }
  await runGit([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    input.plan.commitMessage,
  ], {
    cwd: paths.repositoryPath,
    env: gitCommitEnvironment(input.at),
  });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: paths.repositoryPath });
  await verifyExistingCommit({ ...input, head });
  await requireCleanTree(paths.repositoryPath);
  return { head, created: true };
}

export async function recognizeCommittedWorkstreamContextPlan(input: {
  contextRepositoryPath: string;
  branch: string;
  baseHead: string;
  plan: WorkstreamContextCommitPlan;
}): Promise<string | undefined> {
  const paths = sharedPaths(input.contextRepositoryPath, input.plan);
  const current = await readIdentity(paths.repositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("Shared workstream branch changed during recovery.", input, current.branch);
  }
  if (current.head === input.baseHead) return undefined;
  const runId = /^Run:\s*(\S+)\s*$/m.exec(input.plan.commitMessage)?.[1];
  if (!runId) {
    throw recovery("Finalization commit message is missing its run identity.");
  }
  const candidates = lines(await runGit([
    "log",
    "--all",
    "--format=%H",
    "--fixed-strings",
    "--grep=Run: " + runId,
  ], { cwd: paths.repositoryPath }));
  for (const candidate of candidates) {
    try {
      await verifyExistingCommit({ ...input, head: candidate });
      return candidate;
    } catch (error) {
      if (!(error instanceof ContextEngineServiceError)) throw error;
    }
  }
  return undefined;
}

export function contentHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

async function verifyExistingCommit(input: {
  contextRepositoryPath: string;
  branch: string;
  baseHead: string;
  plan: WorkstreamContextCommitPlan;
  head: string;
}): Promise<void> {
  const shared = sharedPaths(input.contextRepositoryPath, input.plan);
  const parent = await runGit(["rev-parse", input.head + "^"], {
    cwd: shared.repositoryPath,
  });
  const message = await runGit(["show", "-s", "--format=%B", input.head], {
    cwd: shared.repositoryPath,
  });
  const paths = lines(await runGit([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    input.head,
  ], { cwd: shared.repositoryPath })).sort();
  for (const write of input.plan.contextWrites) {
    const committed = await runGit([
      "show",
      input.head + ":" + shared.prefix + write.path,
    ], { cwd: shared.repositoryPath });
    if (committed !== write.content.trimEnd()) {
      throw mismatch("Committed context does not match the finalization journal.", input, input.head);
    }
  }
  if (parent !== input.baseHead
    || message.trim() !== input.plan.commitMessage.trim()
    || JSON.stringify(paths) !== JSON.stringify(shared.staged)) {
    throw mismatch("Commit is not the journaled workstream finalization.", input, input.head);
  }
}

function sharedPaths(
  contextRepositoryPath: string,
  plan: WorkstreamContextCommitPlan,
): {
  repositoryPath: string;
  prefix: string;
  staged: string[];
} {
  const directory = basename(resolve(contextRepositoryPath));
  if (!/^W-\d{8}-\d{4}-[a-z0-9][a-z0-9-]*$/.test(directory)) {
    throw recovery("Finalization target is not a canonical workstream directory.", {
      contextRepositoryPath,
    });
  }
  for (const path of plan.stagedPaths) requireContextPath(path);
  const prefix = directory + "/";
  return {
    repositoryPath: dirname(resolve(contextRepositoryPath)),
    prefix,
    staged: plan.stagedPaths.map((path) => prefix + path).sort(),
  };
}

async function readIdentity(repositoryPath: string): Promise<{ head: string; branch: string }> {
  return {
    head: await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath }),
    branch: await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repositoryPath }),
  };
}

async function requireCleanTree(repositoryPath: string): Promise<void> {
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: repositoryPath,
  });
  if (status) {
    throw recovery("Shared workstream repository is not clean.", {
      workingTreeChanges: status.split("\n").filter(Boolean),
    });
  }
}

async function requireCleanOrJournaledTree(
  repositoryPath: string,
  plannedPaths: string[],
): Promise<void> {
  const staged = lines(await runGit([
    "diff",
    "--cached",
    "--name-only",
    "--",
  ], { cwd: repositoryPath }));
  const unstaged = lines(await runGit([
    "diff",
    "--name-only",
    "--",
  ], { cwd: repositoryPath }));
  const untracked = lines(await runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
  ], { cwd: repositoryPath }));
  const planned = new Set(plannedPaths);
  const journalTemporaries = untracked.filter(
    (path) => isJournalAtomicTemporary(path, plannedPaths),
  );
  for (const path of journalTemporaries) {
    await unlink(join(repositoryPath, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const remainingUntracked = untracked.filter((path) => !journalTemporaries.includes(path));
  const unexpected = [...new Set([...staged, ...unstaged, ...remainingUntracked])]
    .filter((path) => !planned.has(path))
    .sort();
  if (unexpected.length > 0) {
    throw recovery("Shared workstream repository contains changes outside the journal.", {
      unexpectedPaths: unexpected,
    });
  }
}

function isJournalAtomicTemporary(path: string, plannedPaths: string[]): boolean {
  const suffixPattern = /^\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return plannedPaths.some((planned) =>
    path.startsWith(planned) && suffixPattern.test(path.slice(planned.length))
  );
}

function requireContextPath(path: string): void {
  if (path === "workstream.md"
    || path === WORKSTREAM_PROGRESS_PATH
    || path === "resources.json"
    || /^requests\/R-\d{4}-[a-z0-9][a-z0-9-]*\.md$/.test(path)) {
    return;
  }
  throw recovery("Finalization plan contains a non-context path.", { path });
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function mismatch(
  message: string,
  input: { baseHead: string },
  actual: string,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_HEAD_MISMATCH",
    message,
    details: { expectedHead: input.baseHead, actualHead: actual },
  });
}

function recovery(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}
