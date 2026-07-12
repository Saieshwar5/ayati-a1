import type { CommitSummary, SessionRef } from "../contracts.js";
import { runGitRaw } from "../git/git-process.js";

const RECENT_COMMIT_LIMIT = 5;

interface SessionSummaryState {
  head: string;
  summary: string;
  recentCommits: CommitSummary[];
}

export class SessionSummaryHotCache {
  private readonly bySessionId = new Map<string, SessionSummaryState>();

  get(sessionId: string, head: string | null): SessionSummaryState | undefined {
    const cached = this.bySessionId.get(sessionId);
    return cached && cached.head === head ? cached : undefined;
  }

  async refresh(session: SessionRef): Promise<SessionSummaryState> {
    if (!session.head) {
      const empty = { head: "", summary: "", recentCommits: [] };
      this.bySessionId.set(session.sessionId, empty);
      return empty;
    }
    const commits = await readTaskRunSessionCommits(session.repositoryPath);
    const recentCommits = commits.slice(0, RECENT_COMMIT_LIMIT);
    const older = commits.slice(RECENT_COMMIT_LIMIT);
    const state: SessionSummaryState = {
      head: session.head,
      summary: renderOlderSummary(older),
      recentCommits,
    };
    this.bySessionId.set(session.sessionId, state);
    return state;
  }

  invalidate(sessionId: string): void {
    this.bySessionId.delete(sessionId);
  }
}

async function readTaskRunSessionCommits(repositoryPath: string): Promise<CommitSummary[]> {
  const output = await runGitRaw([
    "log",
    "--format=%H%x00%aI%x00%B%x00%x1e",
  ], { cwd: repositoryPath });
  return output.split("\x1e")
    .map((record) => record.replace(/^\s+|\s+$/g, ""))
    .filter(Boolean)
    .map(parseCommit)
    .filter((commit): commit is CommitSummary => Boolean(commit));
}

function parseCommit(record: string): CommitSummary | undefined {
  const [commit, committedAt, ...messageParts] = record.split("\x00");
  const message = messageParts.join("\x00").trim();
  if (!commit || !message.includes("Ayati-Event: task_run_committed")) return undefined;
  const subject = message.split("\n", 1)[0] ?? "session commit";
  return {
    commit,
    subject,
    ...(committedAt ? { committedAt } : {}),
    message,
    conversationSummary: section(message, "Conversation:", "Task work:"),
    workSummary: section(message, "Task work:", "Assets:"),
    outcome: trailer(message, "Outcome"),
    validation: trailer(message, "Validation"),
    taskId: trailer(message, "Task-Id"),
    runId: trailer(message, "Run"),
  };
}

function section(message: string, start: string, end: string): string | undefined {
  const startIndex = message.indexOf(start);
  const endIndex = message.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return undefined;
  const value = message.slice(startIndex + start.length, endIndex).trim();
  return value || undefined;
}

function trailer(message: string, name: string): string | undefined {
  const match = message.match(new RegExp("^" + name + ":\\s*(.+)$", "m"));
  return match?.[1]?.trim();
}

function renderOlderSummary(commits: CommitSummary[]): string {
  if (commits.length === 0) return "";
  return [
    "Older session commits:",
    ...commits.map((commit) => "- " + commit.commit.slice(0, 8) + " — "
      + (commit.workSummary ?? commit.subject)
      + (commit.outcome ? " [" + commit.outcome + "]" : "")),
  ].join("\n");
}
