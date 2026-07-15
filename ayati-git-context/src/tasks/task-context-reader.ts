import type { CommitSummary, TaskCatalogEntry, TaskContextProjection } from "../contracts.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { parseTaskStateCommit } from "./task-state-commit.js";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export async function readTaskContext(
  task: TaskCatalogEntry,
  workingPath?: string,
): Promise<TaskContextProjection> {
  const [pathsOutput, logOutput] = await Promise.all([
    runGit(["ls-tree", "-r", "--name-only", task.head], { cwd: task.repositoryPath }),
    runGitRaw([
      "log",
      "-20",
      "--format=%H%x1f%s%x1f%cI%x1f%B%x1e",
      task.head,
    ], { cwd: task.repositoryPath }),
  ]);
  const importantPaths = pathsOutput
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith(".ayati/"));
  const recentCommits = parseCommits(logOutput);
  const latest = recentCommits.find((commit) => commit.runId) ?? recentCommits[0];
  return {
    task: {
      taskId: task.taskId,
      repositoryPath: task.repositoryPath,
      workingPath: task.workingPath,
      branch: task.branch,
      head: task.head,
    },
    checkoutPath: workingPath ?? task.workingPath,
    workingDirectory: task.workingPath,
    title: latest?.taskTitle ?? task.title,
    objective: task.objective,
    summary: latest?.taskState ?? latest?.workSummary ?? latest?.subject ?? task.objective,
    importantPaths,
    recentCommits,
    ...(latest?.outcome ? { latestOutcome: latest.outcome } : {}),
    ...(latest?.validation ? { validation: latest.validation } : {}),
    ...(latest?.taskStatus ? { taskStatus: latest.taskStatus } : {}),
    ...(latest?.next ? { next: latest.next } : {}),
  };
}

function parseCommits(output: string): CommitSummary[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit = "", subject = "", committedAt = "", ...messageParts] = record.split(FIELD_SEPARATOR);
      const message = messageParts.join(FIELD_SEPARATOR).trim();
      const trailers = parseTrailers(message);
      const state = parseTaskStateCommit(message);
      return {
        commit,
        subject,
        ...(committedAt ? { committedAt } : {}),
        ...(message ? { message } : {}),
        ...(trailers["Conversation"] ? { conversationSummary: trailers["Conversation"] } : {}),
        ...(state?.state
          ? { taskState: state.state, workSummary: state.state }
          : trailers["Summary"] ? { workSummary: trailers["Summary"] } : {}),
        ...(state?.runOutcome
          ? { outcome: state.runOutcome }
          : trailers["Outcome"] ? { outcome: trailers["Outcome"] } : {}),
        ...((state?.validation ?? trailers["Validation"])
          ? { validation: state?.validation ?? trailers["Validation"] }
          : {}),
        ...((state?.taskId ?? trailers["Task-Id"])
          ? { taskId: state?.taskId ?? trailers["Task-Id"] }
          : {}),
        ...((state?.runId ?? trailers["Run"])
          ? { runId: state?.runId ?? trailers["Run"] }
          : {}),
        ...(state ? {
          sessionId: state.sessionId,
          taskTitle: state.title,
          taskStatus: state.status,
          ...(state.next ? { next: state.next } : {}),
          stateVersion: state.version,
        } : {}),
      };
    });
}

function parseTrailers(message: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.+)$/);
    if (match?.[1] && match[2]) result[match[1]] = match[2].trim();
  }
  return result;
}
