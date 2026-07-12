import type { TaskRunOutcome } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { gitCommitEnvironment, runGit } from "./git-process.js";

export async function createTaskFinalizationCommit(input: {
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  taskId: string;
  sessionId: string;
  runId: string;
  conversationId: string;
  conversationHash: string;
  checkpointHead: string;
  outcome: TaskRunOutcome;
  validation: "passed" | "failed" | "not_run";
  summary: string;
  next?: string;
  at: string;
}): Promise<string> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.checkoutPath });
  const dirty = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: input.checkoutPath,
  });
  if (dirty) {
    throw new GitContextServiceError({
      code: "TASK_CHECKOUT_DIRTY",
      message: "Task checkout changed after its last verified checkpoint.",
      details: { taskId: input.taskId, checkoutPath: input.checkoutPath },
    });
  }
  if (head !== input.checkpointHead) {
    const message = await runGit(["show", "-s", "--format=%B", head], {
      cwd: input.checkoutPath,
    });
    const parent = await runGit(["rev-parse", head + "^"], { cwd: input.checkoutPath });
    if (parent === input.checkpointHead
      && message.includes("Run: " + input.runId)
      && message.includes("Ayati-Event: task_run_finalized")) {
      return head;
    }
    throw headMismatch(input.taskId, input.checkpointHead, head);
  }
  await runGit(["commit", "--allow-empty", "-m", taskFinalizationMessage(input)], {
    cwd: input.checkoutPath,
    env: gitCommitEnvironment(input.at),
  });
  return await runGit(["rev-parse", "HEAD"], { cwd: input.checkoutPath });
}

export async function persistTaskFinalization(input: {
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  finalizationHead: string;
}): Promise<void> {
  await runGit([
    "push", input.canonicalRepository,
    input.finalizationHead + ":refs/heads/" + input.branch,
  ], { cwd: input.checkoutPath });
  const head = await runGit(["rev-parse", "refs/heads/" + input.branch], {
    cwd: input.canonicalRepository,
  });
  if (head !== input.finalizationHead) {
    throw headMismatch(undefined, input.finalizationHead, head);
  }
}

function taskFinalizationMessage(input: {
  taskId: string;
  sessionId: string;
  runId: string;
  conversationId: string;
  conversationHash: string;
  outcome: TaskRunOutcome;
  validation: string;
  summary: string;
  next?: string;
}): string {
  return [
    "run: " + subject(input.summary),
    "",
    "Task-Id: " + input.taskId,
    "Session-Id: " + input.sessionId,
    "Run: " + input.runId,
    "Conversation-Id: " + input.conversationId,
    "Conversation-Hash: " + input.conversationHash,
    "Outcome: " + input.outcome,
    "Validation: " + input.validation,
    "Summary: " + singleLine(input.summary),
    "Next: " + (input.next ? singleLine(input.next) : "none"),
    "Ayati-Event: task_run_finalized",
  ].join("\n");
}

function subject(value: string): string {
  return singleLine(value).replace(/[.!?]+$/, "").slice(0, 72).toLowerCase();
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function headMismatch(
  taskId: string | undefined,
  expected: string,
  actual: string,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_HEAD_MISMATCH",
    message: "Task HEAD changed during run finalization.",
    retryable: false,
    details: { ...(taskId ? { taskId } : {}), expectedHead: expected, actualHead: actual },
  });
}
