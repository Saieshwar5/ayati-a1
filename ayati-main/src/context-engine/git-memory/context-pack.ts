import { parseGitMemoryCommitTrailers, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
import type { TaskAssetRecord } from "../contracts.js";
import { GitMemoryWorktreeGitDriver, type GitMemoryLogEntry } from "./git-driver.js";
import type { GitMemoryDailySessionStore } from "./session-store.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemorySessionId,
  GitMemoryTaskAssetsFile,
  GitMemoryTaskFile,
  GitMemoryTaskId,
  GitMemoryTaskIndexFile,
  GitMemoryTaskStateFile,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  gitMemoryTaskDir,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskFilePath,
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

export interface GitMemoryMachineContextPack {
  session: {
    sessionId: GitMemorySessionId;
    conversationTail: GitMemoryConversationRecord[];
    conversationMarkdownTail: string;
    activityTail: GitMemoryCommitActivityRecord[];
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
    assets: TaskAssetRecord[];
    conversationMarkdownTail: string;
    recentRuns: GitMemoryRunFile[];
    recentEvidence: GitMemoryEvidenceManifestRecord[];
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
    const [conversationMarkdownDocument, conversationJsonl, tasks, currentBranch, sessionCommits] = await Promise.all([
      driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH),
      readWorkingJsonl<GitMemoryConversationRecord>(driver, GIT_MEMORY_SESSION_CONVERSATION_PATH),
      readWorkingJson<GitMemoryTaskIndexFile>(driver, GIT_MEMORY_SESSION_TASKS_PATH),
      driver.currentBranch(),
      readRecentCommits(driver, GIT_MEMORY_MAIN_REF, limits.commitLogLimit),
    ]);
    const conversation = readConversationFromMarkdownOrJsonl(
      conversationMarkdownDocument,
      conversationJsonl,
      input.sessionId,
    );
    const conversationMarkdown = markdownTail(conversationMarkdownDocument, limits.conversationMarkdownCharLimit);
    const session = {
      sessionId: input.sessionId,
      conversationTail: tail(conversation, limits.conversationTailLimit),
      conversationMarkdownTail: conversationMarkdown,
      activityTail: deriveSessionActivityTailFromCommits(sessionCommits, limits.activityTailLimit),
      recentCommits: sessionCommits,
      taskCount: tasks?.tasks.length ?? 0,
    };
    const resolvedFocus = resolveActiveFocus(currentBranch, tasks);
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

    const [task, state, assets, conversationMarkdownTail, recentRuns, recentEvidence, recentCommits] = await Promise.all([
      readRefJson<GitMemoryTaskFile>(driver, ref, gitMemoryTaskFilePath(taskEntry.taskId)),
      readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      readTaskAssets(driver, ref, taskEntry.taskId),
      readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limits.conversationMarkdownCharLimit),
      readRecentRuns(driver, ref, taskEntry.taskId, limits.runLimit),
      readRecentEvidence(driver, ref, taskEntry.taskId, limits.evidenceLimit),
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

async function readWorkingJson<T>(driver: GitMemoryWorktreeGitDriver, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readWorkingFile(path));
}

async function readWorkingJsonl<T>(driver: GitMemoryWorktreeGitDriver, path: string): Promise<T[]> {
  return parseJsonl<T>(await driver.readWorkingFile(path));
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
  if (current) {
    return Array.isArray(current.assets) ? current.assets.filter(isTaskAssetRecord) : [];
  }
  return parseJsonl<unknown>(await driver.readFile(ref, gitMemoryTaskLegacyAssetsPath(taskId)))
    .filter(isTaskAssetRecord);
}

function gitMemoryTaskLegacyAssetsPath(taskId: GitMemoryTaskId): string {
  return `${gitMemoryTaskDir(taskId)}/assets.jsonl`;
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

function readConversationFromMarkdownOrJsonl(
  markdown: string | null,
  jsonl: GitMemoryConversationRecord[],
  sessionId: GitMemorySessionId,
): GitMemoryConversationRecord[] {
  const parsed = parseConversationMarkdown(markdown, sessionId);
  if (parsed.length === 0) {
    return jsonl;
  }
  return parsed.map((record) => {
    const existing = jsonl.find((candidate) => candidate.seq === record.seq);
    if (!existing) {
      return record;
    }
    return {
      ...record,
      ...(existing.turnId ? { turnId: existing.turnId } : {}),
      ...(existing.messageId ? { messageId: existing.messageId } : {}),
    };
  });
}

function parseConversationMarkdown(
  value: string | null,
  sessionId: GitMemorySessionId,
): GitMemoryConversationRecord[] {
  if (!value?.trim() || value.trim() === "# Conversation") {
    return [];
  }
  const date = sessionId.match(/^S-(\d{8})-/)?.[1] ?? "unknown";
  const records: GitMemoryConversationRecord[] = [];
  const lines = value.split(/\r?\n/);
  let current: {
    at: string;
    role: GitMemoryConversationRecord["role"];
    body: string[];
    taskId?: GitMemoryTaskId;
    runId?: string;
    branch?: string;
  } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const body = current.body.join("\n").trim();
    const seq = records.length + 1;
    records.push({
      v: 1,
      seq,
      messageId: `M-${date}-markdown-${seq.toString().padStart(6, "0")}`,
      turnId: `T-${date}-markdown-${seq.toString().padStart(6, "0")}`,
      role: current.role,
      at: current.at,
      text: body,
      ...(current.taskId ? { taskId: current.taskId } : {}),
      ...(current.runId ? { runId: current.runId } : {}),
      ...(current.branch ? { branch: current.branch } : {}),
    });
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s+(User|Assistant|System)\s*$/.exec(line);
    if (heading) {
      flush();
      current = {
        at: heading[1]?.trim() ?? "",
        role: heading[2]?.toLowerCase() as GitMemoryConversationRecord["role"],
        body: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const task = /^Task:\s*(\S+)\s*$/.exec(line);
    if (task && current.body.every((entry) => entry.trim() === "")) {
      current.taskId = task[1];
      continue;
    }
    const run = /^Run:\s*(\S+)\s*$/.exec(line);
    if (run && current.body.every((entry) => entry.trim() === "")) {
      current.runId = run[1];
      continue;
    }
    const branch = /^Branch:\s*(\S+)\s*$/.exec(line);
    if (branch && current.body.every((entry) => entry.trim() === "")) {
      current.branch = branch[1];
      continue;
    }
    current.body.push(line);
  }
  flush();
  return records;
}

function resolveActiveFocus(
  currentBranch: string | null,
  tasks: GitMemoryTaskIndexFile | null,
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
    return {
      status: "missing",
      branch: currentBranch,
      reason: "current task branch is missing from session task index",
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
