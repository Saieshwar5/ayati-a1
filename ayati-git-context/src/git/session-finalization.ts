import type { TaskRunOutcome } from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { configureAyatiGitIdentity, gitCommitEnvironment, runGit } from "./git-process.js";

export async function commitTaskRunSession(input: {
  repositoryPath: string;
  sessionId: string;
  conversationId: string;
  taskId: string;
  runId: string;
  outcome: TaskRunOutcome;
  taskHeadBefore: string;
  taskHeadAfter: string;
  expectedSessionHead: string;
  paths: string[];
  at: string;
}): Promise<string> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: input.repositoryPath });
  if (head !== input.expectedSessionHead) {
    const message = await runGit(["show", "-s", "--format=%B", head], {
      cwd: input.repositoryPath,
    });
    const parent = await runGit(["rev-parse", head + "^"], { cwd: input.repositoryPath });
    if (parent === input.expectedSessionHead
      && message.includes("Run: " + input.runId)
      && message.includes("Ayati-Event: task_run_committed")) {
      return head;
    }
    throw sessionMismatch(input.expectedSessionHead, head);
  }
  const existingPaths = [...new Set(input.paths)].sort();
  await runGit(["add", "-A", "--", ...existingPaths], { cwd: input.repositoryPath });
  const staged = (await runGit(["diff", "--cached", "--name-only", "--"], {
    cwd: input.repositoryPath,
  })).split("\n").filter(Boolean).sort();
  const allowed = new Set(existingPaths);
  const unexpected = staged.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Session contains staged files outside task-run finalization ownership.",
      details: { unexpectedPaths: unexpected },
    });
  }
  await configureAyatiGitIdentity(input.repositoryPath);
  await runGit(["commit", "-m", sessionCommitMessage(input)], {
    cwd: input.repositoryPath,
    env: gitCommitEnvironment(input.at),
  });
  return await runGit(["rev-parse", "HEAD"], { cwd: input.repositoryPath });
}

function sessionCommitMessage(input: {
  sessionId: string;
  conversationId: string;
  taskId: string;
  runId: string;
  outcome: TaskRunOutcome;
  taskHeadBefore: string;
  taskHeadAfter: string;
}): string {
  return [
    "session: finalize task run " + input.runId,
    "",
    "Session-Id: " + input.sessionId,
    "Conversation-Id: " + input.conversationId,
    "Task-Id: " + input.taskId,
    "Task-Before: " + input.taskHeadBefore,
    "Task-After: " + input.taskHeadAfter,
    "Run: " + input.runId,
    "Outcome: " + input.outcome,
    "Ayati-Event: task_run_committed",
  ].join("\n");
}

function sessionMismatch(expected: string, actual: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "SESSION_HEAD_MISMATCH",
    message: "Session HEAD changed during task-run finalization.",
    retryable: false,
    details: { expectedHead: expected, actualHead: actual },
  });
}
