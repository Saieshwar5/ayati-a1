import type { MutationProvenance } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { configureAyatiGitIdentity, runGit } from "./git-process.js";

export function checkpointPaths(provenance: MutationProvenance): string[] {
  return [...new Set([
    ...provenance.created,
    ...provenance.modified,
    ...provenance.deleted,
    ...provenance.renamed.flatMap((entry) => [entry.from, entry.to]),
  ])].sort();
}

export function assertCheckpointablePaths(paths: string[]): void {
  const prohibited = paths.filter(isProhibitedPath);
  if (prohibited.length > 0) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Verified mutation includes files that must not be committed.",
      details: { prohibitedPaths: prohibited },
    });
  }
}

export async function stageVerifiedTaskMutation(input: {
  checkoutPath: string;
  branch: string;
  beforeHead: string;
  authorityId: string;
  stagedPaths: string[];
}): Promise<void> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.checkoutPath });
  if (head !== input.beforeHead) {
    throw checkpointMismatch(input, "Task checkout HEAD changed before checkpointing.", head);
  }
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], {
    cwd: input.checkoutPath,
  });
  if (branch !== input.branch) {
    throw checkpointMismatch(input, "Task checkout branch changed before checkpointing.", branch);
  }
  await configureAyatiGitIdentity(input.checkoutPath);
  await runGit(["add", "-A", "--", ...input.stagedPaths], { cwd: input.checkoutPath });
  const staged = await runGit(["diff", "--cached", "--name-only", "--"], {
    cwd: input.checkoutPath,
  });
  const stagedPaths = new Set(staged.split("\n").filter(Boolean));
  const missing = input.stagedPaths.filter((path) => !stagedPaths.has(path));
  if (missing.length > 0) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Verified mutation paths were not retained in the task-run staging area.",
      details: { expectedPaths: input.stagedPaths, missingPaths: missing },
    });
  }
}

function isProhibitedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  return segments.some((segment) => ["node_modules", "dist", "build", ".cache"].includes(segment))
    || name === ".env"
    || name.startsWith(".env.")
    || /(^|[-_.])(credential|credentials|secret|secrets)([-_.]|$)/.test(name)
    || name.endsWith(".log");
}

function checkpointMismatch(
  input: { taskId?: string; beforeHead: string },
  message: string,
  actual: string,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_HEAD_MISMATCH",
    message,
    retryable: false,
    details: {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      expectedHead: input.beforeHead,
      actualHead: actual,
    },
  });
}
