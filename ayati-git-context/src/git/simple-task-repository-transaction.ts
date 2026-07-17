import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import type { SimpleTaskCommitPlan } from "../repositories/simple-task-finalization-records.js";
import { configureAyatiGitIdentity, gitCommitEnvironment, runGit } from "./git-process.js";

export async function commitSimpleTaskPlan(input: {
  repositoryPath: string;
  branch: string;
  baseHead: string;
  plan: SimpleTaskCommitPlan;
  at: string;
}): Promise<{ head: string; created: boolean }> {
  const current = await readIdentity(input.repositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("V1 task branch changed during finalization.", input, current.branch);
  }
  if (current.head !== input.baseHead) {
    await verifyExistingCommit({ ...input, head: current.head });
    return { head: current.head, created: true };
  }
  if (!input.plan.commitRequired) {
    return { head: input.baseHead, created: false };
  }

  await requireVerifiedState(input.repositoryPath, input.plan);
  for (const write of input.plan.contextWrites) {
    requireContextPath(write.path);
    const actual = await readFile(join(input.repositoryPath, write.path), "utf8").catch(
      () => undefined,
    );
    const before = input.plan.contextBefore.find((entry) => entry.path === write.path);
    const actualHash = actual === undefined ? "missing" : contentHash(actual);
    const desiredHash = contentHash(write.content);
    if (!before || (actualHash !== before.sha256 && actualHash !== desiredHash)) {
      throw recovery("Engine-owned V1 context changed after finalization planning.", {
        path: write.path,
      });
    }
    await writeFileAtomically(join(input.repositoryPath, write.path), write.content);
    if (await readFile(join(input.repositoryPath, write.path), "utf8") !== write.content) {
      throw recovery("Rendered V1 task context could not be verified.", { path: write.path });
    }
  }
  await configureAyatiGitIdentity(input.repositoryPath);
  await runGit(["add", "-A", "--", ...input.plan.stagedPaths], {
    cwd: input.repositoryPath,
  });
  const stagedPaths = lines(await runGit([
    "diff", "--cached", "--name-only", "--",
  ], { cwd: input.repositoryPath })).sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(input.plan.stagedPaths)) {
    throw recovery("V1 finalization staged paths do not match its deterministic plan.", {
      expectedPaths: input.plan.stagedPaths,
      actualPaths: stagedPaths,
    });
  }
  const unstagedPaths = lines(await runGit(["diff", "--name-only", "--"], {
    cwd: input.repositoryPath,
  })).sort();
  const untrackedPaths = lines(await runGit([
    "ls-files", "--others", "--exclude-standard",
  ], { cwd: input.repositoryPath })).sort();
  if (unstagedPaths.length > 0 || untrackedPaths.length > 0) {
    throw recovery("V1 finalization found changes outside its exact staged plan.", {
      unstagedPaths,
      untrackedPaths,
    });
  }
  await requireVerifiedState(input.repositoryPath, input.plan);
  if (stagedPaths.length === 0) {
    throw recovery("V1 finalization refused to create an empty task commit.");
  }
  await runGit(["commit", "-m", input.plan.commitMessage], {
    cwd: input.repositoryPath,
    env: gitCommitEnvironment(input.at),
  });
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.repositoryPath });
  await verifyExistingCommit({ ...input, head });
  return { head, created: true };
}

export async function recognizeCommittedSimpleTaskPlan(input: {
  repositoryPath: string;
  branch: string;
  baseHead: string;
  plan: SimpleTaskCommitPlan;
}): Promise<string | undefined> {
  const current = await readIdentity(input.repositoryPath);
  if (current.branch !== input.branch) {
    throw mismatch("V1 task branch changed during recovery.", input, current.branch);
  }
  if (current.head === input.baseHead) return undefined;
  await verifyExistingCommit({ ...input, head: current.head });
  return current.head;
}

export async function readSimpleTaskMutationState(
  repositoryPath: string,
  paths: string[],
): Promise<string> {
  const entries: Array<{ path: string; state: string; mode: string | null }> = [];
  for (const path of [...paths].sort()) {
    const target = join(repositoryPath, path);
    const stat = await lstat(target).catch(() => undefined);
    let state = "deleted";
    if (stat) {
      state = await runGit(["hash-object", "--", path], { cwd: repositoryPath });
    }
    entries.push({
      path,
      state,
      mode: stat
        ? stat.isSymbolicLink()
          ? "120000"
          : stat.isDirectory()
            ? "040000"
            : (stat.mode & 0o111) !== 0 ? "100755" : "100644"
        : null,
    });
  }
  return "sha256:" + createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function readSimpleTaskCommitState(
  repositoryPath: string,
  head: string,
  paths: string[],
): Promise<string> {
  const entries: Array<{ path: string; state: string; mode: string | null }> = [];
  for (const path of [...paths].sort()) {
    const tree = await runGit(["ls-tree", head, "--", path], { cwd: repositoryPath });
    const match = tree.match(/^(\d+)\s+\w+\s+([a-f0-9]+)\t/);
    entries.push({
      path,
      state: match?.[2] ?? "deleted",
      mode: match?.[1] ?? null,
    });
  }
  return "sha256:" + createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function contentHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

async function requireVerifiedState(
  repositoryPath: string,
  plan: SimpleTaskCommitPlan,
): Promise<void> {
  const actual = await readSimpleTaskMutationState(repositoryPath, plan.verifiedPaths);
  if (actual !== plan.verifiedState) {
    throw recovery("Verified V1 task content changed after finalization planning.", {
      expectedState: plan.verifiedState,
      actualState: actual,
    });
  }
}

async function verifyExistingCommit(input: {
  repositoryPath: string;
  branch: string;
  baseHead: string;
  plan: SimpleTaskCommitPlan;
  head: string;
}): Promise<void> {
  const parent = await runGit(["rev-parse", input.head + "^"], { cwd: input.repositoryPath });
  const message = await runGit(["show", "-s", "--format=%B", input.head], {
    cwd: input.repositoryPath,
  });
  const paths = lines(await runGit([
    "diff-tree", "--no-commit-id", "--name-only", "-r", input.head,
  ], { cwd: input.repositoryPath })).sort();
  const verifiedState = await readSimpleTaskCommitState(
    input.repositoryPath,
    input.head,
    input.plan.verifiedPaths,
  );
  if (parent !== input.baseHead
    || message.trim() !== input.plan.commitMessage.trim()
    || JSON.stringify(paths) !== JSON.stringify(input.plan.stagedPaths)
    || verifiedState !== input.plan.verifiedState) {
    throw mismatch("Task HEAD is not the journaled V1 finalization commit.", input, input.head);
  }
}

async function readIdentity(repositoryPath: string): Promise<{ head: string; branch: string }> {
  return {
    head: await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath }),
    branch: await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repositoryPath }),
  };
}

function requireContextPath(path: string): void {
  if (path === ".ayati/task.md" || /^\.ayati\/requests\/R-\d{4}-.+\.md$/.test(path)) {
    return;
  }
  throw recovery("V1 finalization plan contains an unsupported engine-owned path.", { path });
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
    code: "TASK_HEAD_MISMATCH",
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
