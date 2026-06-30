import { parseGitMemoryCommitTrailers, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
import { parseGitMemoryConversationMarkdown } from "./conversation-markdown.js";
import {
  type GitMemoryDerivedTaskEntry,
  readGitMemoryTaskEntries,
} from "./task-refs.js";
import { parseGitMemoryTaskMarkdown } from "./task-markdown.js";
import type { TaskAssetRecord } from "../contracts.js";
import { GitMemoryWorktreeGitDriver, type GitMemoryLogEntry } from "./git-driver.js";
import type { GitMemoryDailySessionStore } from "./session-store.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemorySessionId,
  GitMemoryTaskAssetsFile,
  GitMemoryTaskId,
  GitMemoryTaskStateFile,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  gitMemoryTaskDir,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskStatePath,
} from "./schema.js";
import { GIT_MEMORY_MAIN_REF } from "./session-store.js";

export interface GitMemoryContextLimits {
  conversationTailLimit: number;
  activityTailLimit: number;
  runLimit: number;
  evidenceLimit: number;
  commitLogLimit: number;
  conversationMarkdownCharLimit: number;
}

export const DEFAULT_GIT_MEMORY_CONTEXT_LIMITS: GitMemoryContextLimits = {
  conversationTailLimit: 20,
  activityTailLimit: 30,
  runLimit: 5,
  evidenceLimit: 5,
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

export interface CompactGitMemoryCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  trailers: ParsedGitMemoryCommitTrailers;
}

export interface GitMemoryModelCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  event?: string;
  status?: string;
  at?: string;
  taskId?: string;
  runId?: string;
  branch?: string;
}

export interface GitMemoryCommitActivityRecord {
  seq: number;
  type: string;
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: string;
  branch?: string;
  reason?: string;
  commit?: string;
}

export interface GitMemoryPendingWriteContext {
  id: string;
  type: string;
  label: string;
  status: "pending" | "writing" | "failed";
  createdAt: string;
  startedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface GitMemoryPendingTurnContext {
  fromSeq: number;
  toSeq: number;
  text: string;
  at: string;
  routingStatus: "unbound" | "bound" | "clarifying";
  taskId?: GitMemoryTaskId;
  branch?: string;
  runId?: string;
}

export interface GitMemoryMachineContextPack {
  session: {
    sessionId: GitMemorySessionId;
    conversationTail: GitMemoryConversationRecord[];
    conversationMarkdownTail: string;
    activityTail: GitMemoryCommitActivityRecord[];
    recentCommits: GitMemoryModelCommitSummary[];
    taskCount: number;
  };
  pendingWrites?: GitMemoryPendingWriteContext[];
  pendingTurn?: GitMemoryPendingTurnContext;
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
    assets: TaskAssetRecord[];
    conversationMarkdownTail: string;
    recentRuns: GitMemoryRunFile[];
    recentEvidence: GitMemoryEvidenceManifestRecord[];
    recentCommits: GitMemoryModelCommitSummary[];
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
    const [conversationMarkdownDocument, taskEntries, currentBranch, sessionCommits] = await Promise.all([
      driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH),
      readGitMemoryTaskEntries(driver),
      driver.currentBranch(),
      readRecentCommits(driver, GIT_MEMORY_MAIN_REF, limits.commitLogLimit),
    ]);
    const conversation = parseGitMemoryConversationMarkdown(conversationMarkdownDocument);
    const conversationMarkdown = markdownTail(conversationMarkdownDocument, limits.conversationMarkdownCharLimit);
    const session = {
      sessionId: input.sessionId,
      conversationTail: tail(conversation, limits.conversationTailLimit),
      conversationMarkdownTail: conversationMarkdown,
      activityTail: deriveSessionActivityTailFromCommits(sessionCommits, limits.activityTailLimit),
      recentCommits: sessionCommits.map(toModelCommitSummary),
      taskCount: taskEntries.length,
    };
    const resolvedFocus = resolveActiveFocus(currentBranch, taskEntries);
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

    const taskEntry = taskEntries.find((task) => task.taskId === resolvedFocus.taskId);
    if (!taskEntry) {
      return {
        session,
        focus: {
          status: "missing",
          taskId: resolvedFocus.taskId,
          branch: resolvedFocus.branch,
          reason: "focused task is missing from git task branches",
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

    const [taskMarkdown, state, assets, conversationMarkdownTail, recentRuns, recentEvidence, recentCommits] = await Promise.all([
      driver.readFile(ref, gitMemoryTaskMarkdownPath(taskEntry.taskId)),
      readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      readTaskAssets(driver, ref, taskEntry.taskId),
      readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limits.conversationMarkdownCharLimit),
      readRecentRuns(driver, ref, taskEntry.taskId, limits.runLimit),
      readRecentEvidence(driver, ref, taskEntry.taskId, limits.evidenceLimit),
      readRecentCommits(driver, ref, limits.commitLogLimit),
    ]);
    const task = parseGitMemoryTaskMarkdown(taskMarkdown);
    if (!task || !state) {
      return {
        session,
        focus: {
          status: "missing",
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          reason: "focused task branch is missing task.md or state.json",
        },
      };
    }

    return {
      session: {
        ...session,
        activityTail: deriveSessionActivityTailFromCommits(
          [...sessionCommits, ...recentCommits],
          limits.activityTailLimit,
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
        assets,
        conversationMarkdownTail,
        recentRuns,
        recentEvidence,
        recentCommits: recentCommits.map(toModelCommitSummary),
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

async function readRecentEvidence(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/evidence`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith("/manifest.jsonl"))
    .sort();
  const records: GitMemoryEvidenceManifestRecord[] = [];
  for (const path of paths) {
    records.push(...parseJsonl<GitMemoryEvidenceManifestRecord>(await driver.readFile(ref, path)));
  }
  return tail(records, limit);
}

async function readRecentCommits(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  limit: number,
): Promise<CompactGitMemoryCommitSummary[]> {
  return (await driver.log(ref, limit)).map(compactGitMemoryCommit);
}

function deriveSessionActivityTailFromCommits(
  commits: CompactGitMemoryCommitSummary[],
  limit: number,
): GitMemoryCommitActivityRecord[] {
  const sorted = commits
    .map((commit, index) => ({ commit, index }))
    .filter(({ commit }) => Boolean(commit.trailers.event && commit.trailers.at))
    .sort((left, right) => {
      const atCompare = (left.commit.trailers.at ?? "").localeCompare(right.commit.trailers.at ?? "");
      return atCompare === 0 ? left.index - right.index : atCompare;
    });
  const activities: GitMemoryCommitActivityRecord[] = [];
  for (const { commit } of sorted) {
    const activity = commitToSessionActivity(commit, activities.length + 1);
    if (!activity) {
      continue;
    }
    activities.push(activity);
  }
  return tail(activities, limit);
}

function commitToSessionActivity(
  commit: CompactGitMemoryCommitSummary,
  seq: number,
): GitMemoryCommitActivityRecord | null {
  const event = commit.trailers.event;
  const at = commit.trailers.at;
  if (!event || !at) {
    return null;
  }
  if (event === "session_checkpointed") {
    return null;
  }
  const base = {
    seq,
    type: event,
    at,
    ...(commit.trailers.taskId ? { taskId: commit.trailers.taskId } : {}),
    ...(commit.trailers.runId ? { runId: commit.trailers.runId } : {}),
    ...(commit.trailers.branch ? { branch: commit.trailers.branch } : {}),
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

function toModelCommitSummary(commit: CompactGitMemoryCommitSummary): GitMemoryModelCommitSummary {
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.summary ? { summary: commit.summary } : {}),
    ...(commit.trailers.event ? { event: commit.trailers.event } : {}),
    ...(commit.trailers.status ? { status: commit.trailers.status } : {}),
    ...(commit.trailers.at ? { at: commit.trailers.at } : {}),
    ...(commit.trailers.taskId ? { taskId: commit.trailers.taskId } : {}),
    ...(commit.trailers.runId ? { runId: commit.trailers.runId } : {}),
    ...(commit.trailers.branch ? { branch: commit.trailers.branch } : {}),
  };
}

async function readRefJson<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readFile(ref, path));
}

async function readTaskAssets(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<TaskAssetRecord[]> {
  const current = await readRefJson<GitMemoryTaskAssetsFile>(driver, ref, gitMemoryTaskAssetsPath(taskId));
  return Array.isArray(current?.assets) ? current.assets.filter(isTaskAssetRecord) : [];
}

function isTaskAssetRecord(value: unknown): value is TaskAssetRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.assetId === "string"
    && typeof record.role === "string"
    && typeof record.kind === "string"
    && typeof record.name === "string";
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
  tasks: GitMemoryDerivedTaskEntry[],
): GitMemoryResolvedFocus {
  if (currentBranch?.startsWith("task/")) {
    const taskEntry = tasks.find((task) => task.branch === currentBranch);
    if (taskEntry) {
      return {
        status: "active",
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
      };
    }
    return {
      status: "missing",
      branch: currentBranch,
      reason: "current task branch is not a recognized git-memory task branch",
    };
  }
  return { status: "none" };
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
    activityTailLimit: positiveLimit(input?.activityTailLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.activityTailLimit),
    runLimit: positiveLimit(input?.runLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.runLimit),
    evidenceLimit: positiveLimit(input?.evidenceLimit, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.evidenceLimit),
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
