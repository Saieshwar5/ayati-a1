import { parseGitMemoryCommitTrailers, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
import { GitMemoryWorktreeGitDriver, type GitMemoryLogEntry } from "./git-driver.js";
import type { GitMemoryDailySessionStore } from "./session-store.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryFocusFile,
  GitMemoryRunFile,
  GitMemorySessionEventRecord,
  GitMemorySessionId,
  GitMemoryTaskFile,
  GitMemoryTaskId,
  GitMemoryTaskIndexFile,
  GitMemoryTaskMessageLinkRecord,
  GitMemoryTaskStateFile,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  gitMemoryTaskDir,
  gitMemoryTaskFilePath,
  gitMemoryTaskStatePath,
} from "./schema.js";
import { GIT_MEMORY_MAIN_REF } from "./session-store.js";

export interface GitMemoryContextLimits {
  conversationTailLimit: number;
  eventTailLimit: number;
  taskMessageLinkLimit: number;
  runLimit: number;
  commitLogLimit: number;
  conversationMarkdownCharLimit: number;
}

export const DEFAULT_GIT_MEMORY_CONTEXT_LIMITS: GitMemoryContextLimits = {
  conversationTailLimit: 20,
  eventTailLimit: 30,
  taskMessageLinkLimit: 10,
  runLimit: 5,
  commitLogLimit: 10,
  conversationMarkdownCharLimit: 12_000,
};

export type GitMemoryFocusContext =
  | {
      status: "none";
    }
  | {
      status: "active";
      taskId: GitMemoryTaskId;
      branch: string;
      ref: string;
    }
  | {
      status: "missing";
      taskId?: GitMemoryTaskId;
      branch?: string;
      ref?: string;
      reason: string;
    };

type GitMemoryResolvedFocus =
  | {
      status: "none";
    }
  | {
      status: "active";
      taskId: GitMemoryTaskId;
      branch: string;
    }
  | {
      status: "missing";
      taskId?: GitMemoryTaskId;
      branch?: string;
      reason: string;
    };

export interface GitMemoryContextTaskConversationSegment {
  link: {
    taskId: GitMemoryTaskId;
    branch: string;
    fromSeq: number;
    toSeq: number;
  };
  messages: GitMemoryConversationRecord[];
}

export interface CompactGitMemoryCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  trailers: ParsedGitMemoryCommitTrailers;
}

export interface GitMemoryMachineContextPack {
  session: {
    sessionId: GitMemorySessionId;
    conversationTail: GitMemoryConversationRecord[];
    conversationMarkdownTail: string;
    eventTail: GitMemorySessionEventRecord[];
    taskMessageLinkTail: GitMemoryTaskMessageLinkRecord[];
    recentCommits: CompactGitMemoryCommitSummary[];
    taskCount: number;
  };
  focus: GitMemoryFocusContext;
  task?: {
    ref: string;
    taskId: GitMemoryTaskId;
    branch: string;
    title: string;
    objective: string;
    status: string;
    summary: string;
    completed: string[];
    open: string[];
    blockers: string[];
    facts: string[];
    next: string;
    conversationMarkdownTail: string;
    conversation: GitMemoryContextTaskConversationSegment[];
    recentRuns: GitMemoryRunFile[];
    recentCommits: CompactGitMemoryCommitSummary[];
  };
}

export class GitMemoryContextReader {
  constructor(private readonly store: GitMemoryDailySessionStore) {}

  async buildActiveContext(input: {
    sessionId: GitMemorySessionId;
    limits?: Partial<GitMemoryContextLimits>;
  }): Promise<GitMemoryMachineContextPack> {
    const limits = normalizeLimits(input.limits);
    const driver = await this.store.openExistingDriver(input.sessionId);
    const [conversation, conversationMarkdown, tasks, focus, currentBranch, sessionCommits] = await Promise.all([
      readWorkingJsonl<GitMemoryConversationRecord>(driver, GIT_MEMORY_SESSION_CONVERSATION_PATH),
      readWorkingMarkdownTail(driver, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limits.conversationMarkdownCharLimit),
      readWorkingJson<GitMemoryTaskIndexFile>(driver, GIT_MEMORY_SESSION_TASKS_PATH),
      readWorkingJson<GitMemoryFocusFile>(driver, GIT_MEMORY_SESSION_FOCUS_PATH),
      driver.currentBranch(),
      readRecentCommits(driver, GIT_MEMORY_MAIN_REF, limits.commitLogLimit),
    ]);
    const session = {
      sessionId: input.sessionId,
      conversationTail: tail(conversation, limits.conversationTailLimit),
      conversationMarkdownTail: conversationMarkdown,
      eventTail: deriveSessionEventTailFromCommits(sessionCommits, limits.eventTailLimit),
      taskMessageLinkTail: [],
      recentCommits: sessionCommits,
      taskCount: tasks?.tasks.length ?? 0,
    };
    const resolvedFocus = resolveActiveFocus(currentBranch, tasks, focus);
    if (resolvedFocus.status === "none") {
      return {
        session,
        focus: { status: "none" },
      };
    }
    if (resolvedFocus.status === "missing") {
      return {
        session,
        focus: {
          status: "missing",
          ...(resolvedFocus.taskId ? { taskId: resolvedFocus.taskId } : {}),
          ...(resolvedFocus.branch ? { branch: resolvedFocus.branch } : {}),
          ...(resolvedFocus.branch ? { ref: `refs/heads/${resolvedFocus.branch}` } : {}),
          reason: resolvedFocus.reason,
        },
      };
    }

    const taskEntry = tasks?.tasks.find((task) => task.taskId === resolvedFocus.taskId);
    if (!taskEntry) {
      return {
        session,
        focus: {
          status: "missing",
          taskId: resolvedFocus.taskId,
          branch: resolvedFocus.branch,
          reason: "focused task is missing from session task index",
        },
      };
    }

    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      return {
        session,
        focus: {
          status: "missing",
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          reason: "focused task branch is missing",
        },
      };
    }

    const [task, state, conversationMarkdownTail, recentRuns, recentCommits] = await Promise.all([
      readRefJson<GitMemoryTaskFile>(driver, ref, gitMemoryTaskFilePath(taskEntry.taskId)),
      readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limits.conversationMarkdownCharLimit),
      readRecentRuns(driver, ref, taskEntry.taskId, limits.runLimit),
      readRecentCommits(driver, ref, limits.commitLogLimit),
    ]);
    if (!task || !state) {
      return {
        session,
        focus: {
          status: "missing",
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          reason: "focused task branch is missing task.json or state.json",
        },
      };
    }

    return {
      session: {
        ...session,
        eventTail: deriveSessionEventTailFromCommits(
          [...sessionCommits, ...recentCommits],
          limits.eventTailLimit,
        ),
      },
      focus: {
        status: "active",
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
      },
      task: {
        ref,
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        title: task.title,
        objective: task.objective,
        status: state.status,
        summary: state.summary,
        completed: state.completed,
        open: state.open,
        blockers: state.blockers,
        facts: state.facts,
        next: state.next,
        conversationMarkdownTail,
        conversation: [],
        recentRuns,
        recentCommits,
      },
    };
  }
}

export function compactGitMemoryCommit(entry: GitMemoryLogEntry): CompactGitMemoryCommitSummary {
  const lines = entry.message.split(/\r?\n/);
  const subject = lines[0]?.trim() ?? "";
  const body = lines
    .slice(1)
    .join("\n")
    .split(/^Ayati-/m)[0]
    ?.trim();
  return {
    commit: entry.commit,
    subject,
    ...(body ? { summary: body } : {}),
    trailers: parseGitMemoryCommitTrailers(entry.message),
  };
}

async function readRecentRuns(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryRunFile[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".json"))
    .sort();
  const runs: GitMemoryRunFile[] = [];
  for (const path of tail(paths, limit)) {
    const parsed = await readRefJson<GitMemoryRunFile>(driver, ref, path);
    if (parsed) {
      runs.push(parsed);
    }
  }
  return runs;
}

async function readRecentCommits(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  limit: number,
): Promise<CompactGitMemoryCommitSummary[]> {
  return (await driver.log(ref, limit)).map(compactGitMemoryCommit);
}

function deriveSessionEventTailFromCommits(
  commits: CompactGitMemoryCommitSummary[],
  limit: number,
): GitMemorySessionEventRecord[] {
  const sorted = commits
    .map((commit, index) => ({ commit, index }))
    .filter(({ commit }) => Boolean(commit.trailers.event && commit.trailers.at))
    .sort((left, right) => {
      const atCompare = (left.commit.trailers.at ?? "").localeCompare(right.commit.trailers.at ?? "");
      return atCompare === 0 ? left.index - right.index : atCompare;
    });
  const events: GitMemorySessionEventRecord[] = [];
  for (const { commit } of sorted) {
    const event = commitToSessionEvent(commit, events.length + 1);
    if (!event) {
      continue;
    }
    events.push(event);
    if (event.type === "task_created" && event.taskId && event.branch) {
      events.push({
        v: 1,
        seq: events.length + 1,
        eventId: derivedCommitEventId(commit.commit, events.length + 1, "focus"),
        type: "focus_changed",
        at: event.at,
        toTaskId: event.taskId,
        branch: event.branch,
        reason: "task_created",
      });
    }
  }
  return tail(events, limit);
}

function commitToSessionEvent(
  commit: CompactGitMemoryCommitSummary,
  seq: number,
): GitMemorySessionEventRecord | null {
  const event = commit.trailers.event;
  const at = commit.trailers.at;
  if (!event || !at) {
    return null;
  }
  if (event === "session_checkpointed") {
    return null;
  }
  const base = {
    v: 1 as const,
    seq,
    eventId: derivedCommitEventId(commit.commit, seq),
    type: event,
    at,
    ...(commit.trailers.taskId ? { taskId: commit.trailers.taskId } : {}),
    ...(commit.trailers.runId ? { runId: commit.trailers.runId } : {}),
    ...(commit.trailers.branch ? { branch: commit.trailers.branch } : {}),
    ...(commit.trailers.conversationSeq ? { conversationSeq: commit.trailers.conversationSeq } : {}),
  };
  if (event === "run_completed" || event === "run_failed") {
    return {
      ...base,
      type: event,
      commit: commit.commit,
    };
  }
  if (event === "session_initialized" || event === "task_created" || event === "run_started" || event === "session_closed") {
    return {
      ...base,
      type: event,
    };
  }
  return null;
}

function derivedCommitEventId(commit: string, seq: number, suffix?: string): string {
  return `E-COMMIT-${commit.slice(0, 12)}-${seq}${suffix ? `-${suffix}` : ""}`;
}

async function readWorkingJson<T>(driver: GitMemoryWorktreeGitDriver, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readWorkingFile(path));
}

async function readWorkingJsonl<T>(driver: GitMemoryWorktreeGitDriver, path: string): Promise<T[]> {
  return parseJsonl<T>(await driver.readWorkingFile(path));
}

async function readWorkingMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  path: string,
  limit: number,
): Promise<string> {
  return markdownTail(await driver.readWorkingFile(path), limit);
}

async function readRefJson<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readFile(ref, path));
}

async function readRefMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  path: string,
  limit: number,
): Promise<string> {
  return markdownTail(await driver.readFile(ref, path), limit);
}

function parseJson<T>(value: string | null): T | null {
  if (!value?.trim()) {
    return null;
  }
  return JSON.parse(value) as T;
}

function parseJsonl<T>(value: string | null): T[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function resolveActiveFocus(
  currentBranch: string | null,
  tasks: GitMemoryTaskIndexFile | null,
  focus: GitMemoryFocusFile | null,
): GitMemoryResolvedFocus {
  if (currentBranch?.startsWith("task/")) {
    const taskEntry = tasks?.tasks.find((task) => task.branch === currentBranch);
    if (taskEntry) {
      return {
        status: "active",
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
      };
    }
  }
  if (!focus?.activeTaskId || !focus.activeBranch) {
    return { status: "none" };
  }
  return {
    status: "active",
    taskId: focus.activeTaskId,
    branch: focus.activeBranch,
  };
}

function tail<T>(values: T[], limit: number): T[] {
  return values.slice(-limit);
}

function markdownTail(value: string | null, limit: number): string {
  const trimmed = value?.trimEnd();
  if (!trimmed || trimmed === "# Conversation") {
    return "";
  }
  if (trimmed.length <= limit) {
    return `${trimmed}\n`;
  }
  const sliced = trimmed.slice(-limit);
  const headingIndex = sliced.search(/\n##\s/);
  return `${(headingIndex >= 0 ? sliced.slice(headingIndex + 1) : sliced).trimStart()}\n`;
}

function normalizeLimits(input: Partial<GitMemoryContextLimits> | undefined): GitMemoryContextLimits {
  return {
    conversationTailLimit: positiveLimit(input?.conversationTailLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationTailLimit),
    eventTailLimit: positiveLimit(input?.eventTailLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.eventTailLimit),
    taskMessageLinkLimit: positiveLimit(input?.taskMessageLinkLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.taskMessageLinkLimit),
    runLimit: positiveLimit(input?.runLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.runLimit),
    commitLogLimit: positiveLimit(input?.commitLogLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.commitLogLimit),
    conversationMarkdownCharLimit: positiveLimit(input?.conversationMarkdownCharLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return value;
}
