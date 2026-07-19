import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import type { WorkstreamContextCommitPlan } from "../repositories/workstream-finalization-records.js";
import { gitCommitEnvironment, runGit } from "./git-process.js";

export async function commitWorkstreamContextPlan(input: {
  contextRepositoryPath: string;
  branch: string;
  baseHead: string;
  plan: WorkstreamContextCommitPlan;
  at: string;
}): Promise<{ head: string; created: boolean }> {
  const current = await readIdentity(input.contextRepositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("Workstream context branch changed during finalization.", input, current.branch);
  }
  if (current.head !== input.baseHead) {
    await verifyExistingCommit({ ...input, head: current.head });
    return { head: current.head, created: true };
  }
  if (!input.plan.commitRequired) {
    await requireCleanTree(input.contextRepositoryPath);
    return { head: input.baseHead, created: false };
  }

  await requireCleanTree(input.contextRepositoryPath);
  for (const write of input.plan.contextWrites) {
    requireContextPath(write.path);
    const actual = await readFile(join(input.contextRepositoryPath, write.path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    const before = input.plan.contextBefore.find((entry) => entry.path === write.path);
    const actualHash = actual === undefined ? "missing" : contentHash(actual);
    const desiredHash = contentHash(write.content);
    if (!before || (actualHash !== before.sha256 && actualHash !== desiredHash)) {
      throw recovery("Engine-owned workstream context changed after finalization planning.", {
        path: write.path,
      });
    }
    await writeFileAtomically(join(input.contextRepositoryPath, write.path), write.content);
    if (await readFile(join(input.contextRepositoryPath, write.path), "utf8") !== write.content) {
      throw recovery("Rendered workstream context could not be verified.", { path: write.path });
    }
  }
  await runGit(["add", "-A", "--", ...input.plan.stagedPaths], {
    cwd: input.contextRepositoryPath,
  });
  const stagedPaths = lines(await runGit([
    "diff", "--cached", "--name-only", "--",
  ], { cwd: input.contextRepositoryPath })).sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(input.plan.stagedPaths)) {
    throw recovery("Finalization staged paths do not match its context-only plan.", {
      expectedPaths: input.plan.stagedPaths,
      actualPaths: stagedPaths,
    });
  }
  const unstagedPaths = lines(await runGit(["diff", "--name-only", "--"], {
    cwd: input.contextRepositoryPath,
  })).sort();
  const untrackedPaths = lines(await runGit([
    "ls-files", "--others", "--exclude-standard",
  ], { cwd: input.contextRepositoryPath })).sort();
  if (unstagedPaths.length > 0 || untrackedPaths.length > 0) {
    throw recovery("Workstream context contains changes outside the exact finalization plan.", {
      unstagedPaths,
      untrackedPaths,
    });
  }
  if (stagedPaths.length === 0) {
    throw recovery("Finalization refused to create an empty workstream context commit.");
  }
  await runGit(["-c", "commit.gpgsign=false", "commit", "-m", input.plan.commitMessage], {
    cwd: input.contextRepositoryPath,
    env: gitCommitEnvironment(input.at),
  });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.contextRepositoryPath });
  await verifyExistingCommit({ ...input, head });
  await requireCleanTree(input.contextRepositoryPath);
  return { head, created: true };
}

export async function recognizeCommittedWorkstreamContextPlan(input: {
  contextRepositoryPath: string;
  branch: string;
  baseHead: string;
  plan: WorkstreamContextCommitPlan;
}): Promise<string | undefined> {
  const current = await readIdentity(input.contextRepositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("Workstream context branch changed during recovery.", input, current.branch);
  }
  if (current.head === input.baseHead) return undefined;
  await verifyExistingCommit({ ...input, head: current.head });
  return current.head;
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
  const parent = await runGit(["rev-parse", input.head + "^"], { cwd: input.contextRepositoryPath });
  const message = await runGit(["show", "-s", "--format=%B", input.head], {
    cwd: input.contextRepositoryPath,
  });
  const paths = lines(await runGit([
    "diff-tree", "--no-commit-id", "--name-only", "-r", input.head,
  ], { cwd: input.contextRepositoryPath })).sort();
  for (const write of input.plan.contextWrites) {
    const committed = await runGit(["show", input.head + ":" + write.path], {
      cwd: input.contextRepositoryPath,
    });
    if (committed !== write.content.trimEnd()) {
      throw mismatch("Workstream HEAD does not contain the journaled context.", input, input.head);
    }
  }
  if (parent !== input.baseHead
    || message.trim() !== input.plan.commitMessage.trim()
    || JSON.stringify(paths) !== JSON.stringify(input.plan.stagedPaths)) {
    throw mismatch("Workstream HEAD is not the journaled finalization commit.", input, input.head);
  }
}

async function readIdentity(contextRepositoryPath: string): Promise<{ head: string; branch: string }> {
  return {
    head: await runGit(["rev-parse", "HEAD"], { cwd: contextRepositoryPath }),
    branch: await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: contextRepositoryPath }),
  };
}

async function requireCleanTree(contextRepositoryPath: string): Promise<void> {
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: contextRepositoryPath,
  });
  if (status) {
    throw recovery("Workstream context repository is not clean.", {
      workingTreeChanges: status.split("\n").filter(Boolean),
    });
  }
}

function requireContextPath(path: string): void {
  if (path === "workstream.md" || path === "resources.json"
    || /^requests\/R-\d{4}-.+\.md$/.test(path)) {
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
): GitContextServiceError {
  return new GitContextServiceError({
    code: "WORKSTREAM_HEAD_MISMATCH",
    message,
    details: { expectedHead: input.baseHead, actualHead: actual },
  });
}

function recovery(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}
