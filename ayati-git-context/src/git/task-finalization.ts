import type { TaskRunOutcome } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import {
  persistentTaskStatusForOutcome,
  renderTaskStateCommit,
  TASK_STATE_VERSION,
} from "../tasks/task-state-commit.js";
import { gitCommitEnvironment, runGit } from "./git-process.js";

export async function createTaskFinalizationCommit(input: {
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  taskId: string;
  taskTitle: string;
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
  const unstaged = await runGit(["diff", "--name-only", "--"], {
    cwd: input.checkoutPath,
  });
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], {
    cwd: input.checkoutPath,
  });
  if (unstaged || untracked) {
    throw new GitContextServiceError({
      code: "TASK_CHECKOUT_DIRTY",
      message: "Task checkout contains changes that were not staged by verified task steps.",
      details: {
        taskId: input.taskId,
        checkoutPath: input.checkoutPath,
        unstagedPaths: unstaged.split("\n").filter(Boolean),
        untrackedPaths: untracked.split("\n").filter(Boolean),
      },
    });
  }
  if (head !== input.checkpointHead) {
    const message = await runGit(["show", "-s", "--format=%B", head], {
      cwd: input.checkoutPath,
    });
    const parent = await runGit(["rev-parse", head + "^"], { cwd: input.checkoutPath });
    if (parent === input.checkpointHead
      && message.includes("Run: " + input.runId)
      && message.includes("Ayati-Event: task_run_committed")) {
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
  taskTitle: string;
  sessionId: string;
  runId: string;
  conversationId: string;
  conversationHash: string;
  outcome: TaskRunOutcome;
  validation: "passed" | "failed" | "not_run";
  summary: string;
  next?: string;
}): string {
  return renderTaskStateCommit({
    version: TASK_STATE_VERSION,
    taskId: input.taskId,
    title: input.taskTitle,
    status: persistentTaskStatusForOutcome(input.outcome),
    state: input.summary,
    validation: input.validation,
    next: input.next ?? null,
    runId: input.runId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationHash: input.conversationHash,
    runOutcome: input.outcome,
  });
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
