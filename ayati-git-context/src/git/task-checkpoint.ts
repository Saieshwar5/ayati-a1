import type { MutationProvenance } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import {
  configureAyatiGitIdentity,
  gitCommitEnvironment,
  runGit,
} from "./git-process.js";

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

export async function createTaskCheckpoint(input: {
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  authorityId: string;
  taskId: string;
  sessionId: string;
  runId: string;
  conversationId: string;
  conversationHash: string;
  purpose: string;
  stagedPaths: string[];
  at: string;
}): Promise<string> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.checkoutPath });
  if (head !== input.beforeHead) {
    const parent = await runGit(["rev-parse", head + "^"], { cwd: input.checkoutPath });
    const message = await runGit(["show", "-s", "--format=%B", head], {
      cwd: input.checkoutPath,
    });
    if (parent === input.beforeHead
      && message.includes("Authority-Id: " + input.authorityId)
      && message.includes("Ayati-Event: task_checkpoint")) {
      return head;
    }
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
  const stagedPaths = staged.split("\n").filter(Boolean).sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(input.stagedPaths)) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Git staged paths do not match verified mutation provenance.",
      details: { expectedPaths: input.stagedPaths, stagedPaths },
    });
  }
  await runGit(["commit", "-m", checkpointCommitMessage(input)], {
    cwd: input.checkoutPath,
    env: gitCommitEnvironment(input.at),
  });
  return await runGit(["rev-parse", "HEAD"], { cwd: input.checkoutPath });
}

export async function persistTaskCheckpoint(input: {
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  checkpointHead: string;
}): Promise<void> {
  await runGit([
    "push",
    input.canonicalRepository,
    input.checkpointHead + ":refs/heads/" + input.branch,
  ], { cwd: input.checkoutPath });
  const canonicalHead = await runGit(["rev-parse", "refs/heads/" + input.branch], {
    cwd: input.canonicalRepository,
  });
  if (canonicalHead !== input.checkpointHead) {
    throw checkpointMismatch(input, "Canonical task repository did not retain checkpoint.", canonicalHead);
  }
}

function checkpointCommitMessage(input: {
  purpose: string;
  authorityId: string;
  taskId: string;
  sessionId: string;
  runId: string;
  conversationId: string;
  conversationHash: string;
}): string {
  return [
    "task: " + sentenceSubject(input.purpose),
    "",
    "Purpose: " + singleLine(input.purpose),
    "Task-Id: " + input.taskId,
    "Session-Id: " + input.sessionId,
    "Run: " + input.runId,
    "Conversation-Id: " + input.conversationId,
    "Conversation-Hash: " + input.conversationHash,
    "Authority-Id: " + input.authorityId,
    "Verification: passed",
    "Ayati-Event: task_checkpoint",
  ].join("\n");
}

function sentenceSubject(value: string): string {
  return singleLine(value).replace(/[.!?]+$/, "").slice(0, 72).toLowerCase();
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
