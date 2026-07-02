import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskAssetRecord } from "../contracts.js";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { parseGitMemoryCommitTrailers, renderGitMemoryCommitMessage, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
import {
  parseGitMemoryConversationMessageFiles,
  parseGitMemoryConversationMarkdown,
  renderGitMemoryConversationMessageFile,
  renderGitMemoryConversationMarkdownDocument,
} from "./conversation-markdown.js";
import {
  gitMemorySessionActiveTaskRef,
  gitMemorySessionLatestBaseRef,
  gitMemorySessionLatestRunRef,
  gitMemorySessionTaskRef,
  gitMemoryTaskLatestRunRef,
  readGitMemoryCustomRef,
  writeGitMemoryCustomRef,
} from "./custom-refs.js";
import {
  nextGitMemoryTaskSequence,
  readGitMemoryTaskEntries,
  readGitMemorySessionTaskEntries,
  resolveGitMemoryTaskEntry,
  type GitMemoryDerivedTaskEntry,
} from "./task-refs.js";
import {
  parseGitMemoryTaskMarkdown,
  renderGitMemoryTaskMarkdown,
  type GitMemoryTaskMarkdownFile,
} from "./task-markdown.js";
import { renderGitMemoryTaskNotes } from "./task-notes.js";
import {
  renderGitMemorySessionSummaryMarkdown,
  renderGitMemorySessionSummaryMetadata,
} from "./session-summary.js";
import type {
  GitMemoryActionId,
  GitMemoryActionRecord,
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryConversationSeqRange,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunId,
  GitMemoryRunFile,
  GitMemoryRunStatus,
  GitMemorySessionAttachmentRecord,
  GitMemorySessionAttachmentsFile,
  GitMemorySessionId,
  GitMemorySessionMetaFile,
  GitMemorySessionSummaryMetaFile,
  GitMemoryTaskId,
  GitMemoryTaskAssetsFile,
  GitMemoryTaskStateFile,
  GitMemoryTaskStatus,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  buildGitMemoryTaskBranchName,
  buildGitMemoryTaskBranchRef,
  createGitMemoryActionId,
  createGitMemoryRunId,
  createGitMemorySessionId,
  createGitMemoryTaskId,
  gitMemoryDateFromSessionId,
  gitMemoryTaskDir,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskActionsPath,
  gitMemoryTaskContextPath,
  gitMemoryTaskConversationDir,
  gitMemoryTaskEvidenceManifestPath,
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStatePath,
  gitMemorySessionStoreMessagePath,
  gitMemorySessionStoreMessagesDir,
  gitMemorySessionStoreMetaPath,
  gitMemorySessionStoreSchemaPath,
  gitMemorySessionStoreAttachmentsPath,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  isGitMemorySessionId,
} from "./schema.js";

export const GIT_MEMORY_MAIN_REF = "refs/heads/main";

export interface GitMemoryDailySessionStoreOptions {
  contextStoreDir: string;
  now?: () => Date;
}

export interface OpenGitMemoryDailySessionInput {
  date: string;
  timezone: string;
  agentId: string;
  createdAt?: string;
  sessionId?: GitMemorySessionId;
}

export interface GitMemoryDailySessionHandle {
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  initialCommit?: string;
}

export interface GitMemoryDailySessionListEntry {
  sessionId: GitMemorySessionId;
  repoPath: string;
  date?: string;
  timezone?: string;
  agentId?: string;
  createdAt?: string;
  taskCount: number;
  activeTaskId?: GitMemoryTaskId;
  activeBranch?: string;
  missingMainRef?: boolean;
  missingMeta?: boolean;
}

export type GitMemoryTaskDetailInclude =
  | "task"
  | "state"
  | "runs"
  | "markdown"
  | "actions"
  | "assets"
  | "commits"
  | "evidence"
  | "conversation";

export interface GitMemoryTaskDetailLimits {
  runLimit: number;
  actionRunLimit: number;
  actionLimit: number;
  commitLogLimit: number;
  evidenceLimit: number;
  conversationMarkdownCharLimit: number;
  taskMarkdownCharLimit: number;
  runMarkdownCharLimit: number;
}

export interface ReadGitMemoryTaskDetailInput {
  sessionId: GitMemorySessionId;
  taskId?: GitMemoryTaskId;
  branch?: string;
  include?: GitMemoryTaskDetailInclude[];
  limits?: Partial<GitMemoryTaskDetailLimits>;
}

export interface GitMemoryTaskActionGroup {
  runId: GitMemoryRunId;
  path: string;
  actions: GitMemoryActionRecord[];
}

export interface GitMemoryTaskRunMarkdown {
  runId: GitMemoryRunId;
  path: string;
  markdown: string;
}

export interface CompactGitMemoryStoreCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  trailers: ParsedGitMemoryCommitTrailers;
}

export interface GitMemoryTaskDetail {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  task?: GitMemoryTaskMarkdownFile;
  taskMarkdown?: string;
  state?: GitMemoryTaskStateFile;
  assets?: TaskAssetRecord[];
  recentRuns?: GitMemoryRunFile[];
  recentRunMarkdown?: GitMemoryTaskRunMarkdown[];
  recentActions?: GitMemoryTaskActionGroup[];
  recentCommits?: CompactGitMemoryStoreCommitSummary[];
  recentEvidence?: GitMemoryEvidenceManifestRecord[];
  conversationMarkdownTail?: string;
}

export interface ReadGitMemorySessionLogInput {
  sessionId: GitMemorySessionId;
  target: "main" | "task";
  taskId?: GitMemoryTaskId;
  branch?: string;
  limit?: number;
}

export interface GitMemorySessionLog {
  sessionId: GitMemorySessionId;
  target: "main" | "task";
  ref: string;
  taskId?: GitMemoryTaskId;
  branch?: string;
  commits: CompactGitMemoryStoreCommitSummary[];
}

export interface SearchGitMemoryTasksInput {
  sessionId: GitMemorySessionId;
  query: string;
  limit?: number;
  status?: GitMemoryTaskStatus;
}

export interface GitMemoryTaskSearchMatch extends GitMemoryTaskRoutingSnapshotTask {
  score: number;
  matchReasons: string[];
}

export interface GitMemoryTaskSearchResult {
  sessionId: GitMemorySessionId;
  query: string;
  status?: GitMemoryTaskStatus;
  matches: GitMemoryTaskSearchMatch[];
}

export interface ReadGitMemoryEvidenceInput {
  sessionId: GitMemorySessionId;
  taskId?: GitMemoryTaskId;
  branch?: string;
  runId?: GitMemoryRunId;
  limit?: number;
}

export interface GitMemoryTaskEvidenceResult {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  runId?: GitMemoryRunId;
  evidence: GitMemoryEvidenceManifestRecord[];
}

export interface SearchGitMemoryEvidenceInput {
  sessionId: GitMemorySessionId;
  query: string;
  taskId?: GitMemoryTaskId;
  branch?: string;
  limit?: number;
}

export interface GitMemoryEvidenceSearchMatch {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  evidence: GitMemoryEvidenceManifestRecord;
  score: number;
  matchReasons: string[];
}

export interface GitMemoryEvidenceSearchResult {
  sessionId: GitMemorySessionId;
  query: string;
  taskId?: GitMemoryTaskId;
  branch?: string;
  matches: GitMemoryEvidenceSearchMatch[];
}

export interface GitMemorySessionCheckpointInput {
  sessionId: GitMemorySessionId;
  summary?: string;
  at?: string;
}

export interface GitMemorySessionCheckpoint {
  commit: string;
}

export interface AppendGitMemoryConversationInput {
  sessionId: GitMemorySessionId;
  role: GitMemoryConversationRole;
  text: string;
  at?: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface AppendGitMemoryConversationRecordInput {
  sessionId: GitMemorySessionId;
  record: GitMemoryConversationRecord;
}

export interface GitMemoryTaskRoutingSnapshotTask {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  summary: string;
  open: string[];
  blockers: string[];
  facts: string[];
  next: string;
  updatedAt?: string;
  latestRunId?: GitMemoryRunId;
  files?: string[];
  missing?: boolean;
}

export interface GitMemoryTaskRoutingFocus {
  activeTaskId: GitMemoryTaskId;
  activeBranch: string;
  reason: "current_branch";
}

export interface GitMemoryTaskRoutingSnapshot {
  sessionId: GitMemorySessionId;
  focus: GitMemoryTaskRoutingFocus | null;
  tasks: GitMemoryTaskRoutingSnapshotTask[];
}

export interface CreateGitMemoryTaskBranchInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  title: string;
  objective: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  status?: GitMemoryTaskStatus;
  at?: string;
  state?: Partial<Omit<GitMemoryTaskStateFile, "schemaVersion" | "status" | "updatedAt">> & {
    status?: GitMemoryTaskStatus;
  };
}

export interface CreateGitMemoryTaskBranchResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  state: GitMemoryTaskStateFile;
  taskCommit: string;
}

export interface SelectGitMemoryTaskForTurnInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  reason: "task_continued" | "task_switched" | "task_reopened";
  at?: string;
  runId?: GitMemoryRunId;
  summary?: string;
}

export interface SelectGitMemoryTaskForTurnResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
}

export interface CommitGitMemoryTaskRunActionInput {
  actionId?: GitMemoryActionId;
  tool: string;
  status: GitMemoryActionRecord["status"];
  summary: string;
  startedAt?: string;
  completedAt?: string;
  evidenceRef?: string;
}

export interface CommitGitMemoryTaskRunEvidenceInput {
  step?: number;
  actionId?: GitMemoryActionId;
  tool: string;
  status?: GitMemoryActionRecord["status"];
  summary: string;
  evidenceRef?: string;
  artifacts?: string[];
  facts?: string[];
  accessModes?: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  source?: Record<string, unknown>;
}

export interface CommitGitMemoryTaskRunInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  status: GitMemoryRunStatus;
  startedAt?: string;
  completedAt?: string;
  conversationRefs: GitMemoryConversationSeqRange[];
  sessionStoreCommit?: string;
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed?: string[];
  verification?: string[];
  decisions?: string[];
  blockers?: string[];
  assistantResponse?: string;
  actions?: CommitGitMemoryTaskRunActionInput[];
  toolCallCount?: number;
  changedFiles?: string[];
  newFacts?: string[];
  next?: string;
  state?: Partial<Omit<GitMemoryTaskStateFile, "schemaVersion" | "updatedAt">>;
  evidence?: CommitGitMemoryTaskRunEvidenceInput[];
  assets?: TaskAssetRecord[];
}

export interface CommitGitMemoryTaskRunResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  runId: GitMemoryRunId;
  taskCommit: string;
  sessionStoreCommit?: string;
}

export interface CommitGitMemorySessionStoreSnapshotInput {
  sessionId: GitMemorySessionId;
  at?: string;
  summary?: string;
}

export interface CommitGitMemorySessionStoreSnapshotResult {
  sessionStoreCommit: string;
  parentCommit: string;
}

export interface WriteGitMemorySessionSummaryInput {
  sessionId: GitMemorySessionId;
  text: string;
  updatedAt?: string;
  strategy?: GitMemorySessionSummaryMetaFile["strategy"];
  coveredUntilSeq?: number;
  messageCount?: number;
  sourceFromSeq?: number;
  sourceToSeq?: number;
  previousCoveredUntilSeq?: number;
  commitSummary?: string;
}

export interface WriteGitMemorySessionSummaryResult {
  sessionStoreCommit: string;
  metadata: GitMemorySessionSummaryMetaFile;
}

export interface UpsertGitMemorySessionAttachmentsInput {
  sessionId: GitMemorySessionId;
  attachments: GitMemorySessionAttachmentRecord[];
  updatedAt?: string;
}

export interface WriteGitMemorySessionAttachmentsInput {
  sessionId: GitMemorySessionId;
  file: GitMemorySessionAttachmentsFile;
}

export interface ReadCommittedGitMemoryTaskRunInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  runId: GitMemoryRunId;
}

export interface StartGitMemoryTaskRunInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  runId: GitMemoryRunId;
  at?: string;
}

export interface StartGitMemoryTaskRunResult {
  runId: GitMemoryRunId;
}

export class GitMemoryDailySessionStore {
  private readonly contextStoreDir: string;
  private readonly nowProvider: () => Date;

  constructor(options: GitMemoryDailySessionStoreOptions) {
    this.contextStoreDir = options.contextStoreDir;
    this.nowProvider = options.now ?? (() => new Date());
  }

  repoPath(sessionId: GitMemorySessionId): string {
    return join(this.contextStoreDir, "sessions", sessionId);
  }

  async openExistingDriver(sessionId: GitMemorySessionId): Promise<GitMemoryWorktreeGitDriver> {
    const repoPath = this.repoPath(sessionId);
    if (!(await pathExists(join(repoPath, ".git")))) {
      throw new Error(`Git memory session not found: ${sessionId}`);
    }
    return new GitMemoryWorktreeGitDriver(repoPath);
  }

  async listSessions(input: { limit?: number } = {}): Promise<GitMemoryDailySessionListEntry[]> {
    const sessionsDir = join(this.contextStoreDir, "sessions");
    const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const limit = normalizeReadLimit(input.limit, 50);
    const sessions: GitMemoryDailySessionListEntry[] = [];

    for (const entry of entries
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
      .reverse()) {
      if (sessions.length >= limit) {
        break;
      }

      const repoPath = this.repoPath(entry);
      if (!(await pathExists(join(repoPath, ".git")))) {
        continue;
      }

      const driver = new GitMemoryWorktreeGitDriver(repoPath);
      const [hasMainRef, meta, tasks, currentBranch] = await Promise.all([
        driver.hasRef(GIT_MEMORY_MAIN_REF),
        readSessionMeta(driver, entry),
        readGitMemoryTaskEntries(driver),
        driver.currentBranch(),
      ]);
      const branchActiveTask = currentBranch?.startsWith("task/")
        ? tasks.find((task) => task.branch === currentBranch)
        : undefined;
      const activeTask = await activeTaskFromCustomRef(driver, meta?.sessionId ?? entry, tasks)
        ?? branchActiveTask;

      sessions.push({
        sessionId: meta?.sessionId ?? entry,
        repoPath,
        ...(meta?.date ? { date: meta.date } : {}),
        ...(meta?.timezone ? { timezone: meta.timezone } : {}),
        ...(meta?.agentId ? { agentId: meta.agentId } : {}),
        ...(meta?.createdAt ? { createdAt: meta.createdAt } : {}),
        taskCount: tasks.length,
        ...(activeTask ? { activeTaskId: activeTask.taskId } : {}),
        ...(activeTask ? { activeBranch: activeTask.branch } : {}),
        ...(!hasMainRef ? { missingMainRef: true } : {}),
        ...(!meta ? { missingMeta: true } : {}),
      });
    }

    return sessions;
  }

  async openOrCreateDailySession(input: OpenGitMemoryDailySessionInput): Promise<GitMemoryDailySessionHandle> {
    const sessionId = input.sessionId ?? createGitMemorySessionId(input.date, input.agentId);
    const repoPath = this.repoPath(sessionId);
    const driver = await GitMemoryWorktreeGitDriver.init(repoPath);
    if (await driver.hasRef(GIT_MEMORY_MAIN_REF)) {
      await this.ensureSessionStoreInitialized(driver, {
        sessionId,
        date: input.date,
        timezone: input.timezone,
        agentId: input.agentId,
        createdAt: input.createdAt ?? this.nowProvider().toISOString(),
      });
      return { sessionId, repoPath, initialized: false };
    }

    const createdAt = input.createdAt ?? this.nowProvider().toISOString();
    await this.ensureSessionStoreInitialized(driver, {
      sessionId,
      date: input.date,
      timezone: input.timezone,
      agentId: input.agentId,
      createdAt,
    });
    const initialCommit = await driver.commitSubmoduleGitlink(
      GIT_MEMORY_SESSION_STORE_DIR,
      renderGitMemoryCommitMessage({
        subject: `ayati: initialize session ${sessionId}`,
        summary: "Create the daily git-memory session repo and point at the session-store metadata snapshot.",
        trailers: {
          sessionId,
          event: "session_initialized",
          at: createdAt,
          schemaVersion: 1,
        },
      }),
    );
    if (!initialCommit) {
      throw new Error(`Git memory parent session commit is missing for ${sessionId}.`);
    }
    await writeGitMemoryCustomRef(driver, gitMemorySessionLatestBaseRef(sessionId), initialCommit);

    return { sessionId, repoPath, initialized: true, initialCommit };
  }

  async readSessionConversationRecords(sessionId: GitMemorySessionId): Promise<GitMemoryConversationRecord[]> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
    const records = await readSessionMessageStoreConversation(driver, sessionId);
    if (records.length > 0) {
      return records;
    }
    return await readWorkingConversation(driver);
  }

  async readSessionAttachments(sessionId: GitMemorySessionId): Promise<GitMemorySessionAttachmentsFile | null> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
    return await readSessionMessageStoreAttachments(driver, sessionId);
  }

  async writeSessionAttachments(
    input: WriteGitMemorySessionAttachmentsInput,
  ): Promise<GitMemorySessionAttachmentsFile> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const file = normalizeSessionAttachmentsFile(input.sessionId, input.file);
    if (!file) {
      throw new Error(`Invalid git memory session attachments file for session: ${input.sessionId}`);
    }
    await writeSessionMessageStoreAttachments(driver, input.sessionId, file);
    return file;
  }

  async upsertSessionAttachments(
    input: UpsertGitMemorySessionAttachmentsInput,
  ): Promise<GitMemorySessionAttachmentsFile> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const existing = await readSessionMessageStoreAttachments(driver, input.sessionId);
    const updatedAt = input.updatedAt ?? this.nowIso();
    const attachmentsById = new Map<string, GitMemorySessionAttachmentRecord>();
    for (const attachment of existing?.attachments ?? []) {
      attachmentsById.set(attachment.sessionAssetId, attachment);
    }
    for (const attachment of input.attachments.filter(isGitMemorySessionAttachmentRecord)) {
      const previous = attachmentsById.get(attachment.sessionAssetId);
      attachmentsById.set(attachment.sessionAssetId, {
        ...previous,
        ...attachment,
        createdAt: previous?.createdAt ?? attachment.createdAt,
        lastUsedAt: attachment.lastUsedAt ?? updatedAt,
      });
    }
    const file: GitMemorySessionAttachmentsFile = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      updatedAt,
      attachments: [...attachmentsById.values()].sort(compareSessionAttachments),
    };
    await writeSessionMessageStoreAttachments(driver, input.sessionId, file);
    return file;
  }

  async appendConversationMessage(input: AppendGitMemoryConversationInput): Promise<GitMemoryConversationRecord> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const existing = await readSessionConversation(driver, input.sessionId);
    const branch = await driver.currentBranch();
    const seq = nextSeq(existing);
    const record: GitMemoryConversationRecord = {
      seq,
      role: input.role,
      at: input.at ?? this.nowIso(),
      text: input.text,
      ...(branch && branch !== "main" ? { branch } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    await writeSessionMessageStoreWorkingRecord(driver, input.sessionId, record);
    return record;
  }

  async appendMainConversationMessage(input: AppendGitMemoryConversationInput): Promise<GitMemoryConversationRecord> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const existing = await readSessionConversation(driver, input.sessionId);
    const seq = nextSeq(existing);
    const record: GitMemoryConversationRecord = {
      seq,
      role: input.role,
      at: input.at ?? this.nowIso(),
      text: input.text,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    await writeSessionMessageStoreWorkingRecord(driver, input.sessionId, record);
    return record;
  }

  async appendMainConversationRecord(
    input: AppendGitMemoryConversationRecordInput,
  ): Promise<GitMemoryConversationRecord> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    await writeSessionMessageStoreWorkingRecord(driver, input.sessionId, input.record);
    return input.record;
  }

  async allocateTaskRunId(sessionId: GitMemorySessionId): Promise<GitMemoryRunId> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
    const date = gitMemoryDateFromSessionId(sessionId);
    return createGitMemoryRunId(date, await nextRunSequenceFromTasks(driver));
  }

  async startTaskRun(input: StartGitMemoryTaskRunInput): Promise<StartGitMemoryTaskRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const ref = `refs/heads/${input.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    return { runId: input.runId };
  }

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    const driver = await this.openExistingDriver(sessionId);
    return await readTaskRoutingSnapshotFromDriver(driver, sessionId);
  }

  async readTaskDetail(input: ReadGitMemoryTaskDetailInput): Promise<GitMemoryTaskDetail> {
    const driver = await this.openExistingDriver(input.sessionId);
    const taskEntry = await resolveGitMemoryTaskEntry(driver, input);
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }

    const include = normalizeTaskDetailInclude(input.include);
    const limits = normalizeTaskDetailLimits(input.limits);
    const detail: GitMemoryTaskDetail = {
      sessionId: input.sessionId,
      taskId: taskEntry.taskId,
      branch: taskEntry.branch,
      ref,
    };

    const readTaskMarkdown = include.has("task") || include.has("markdown")
      ? driver.readFile(ref, gitMemoryTaskMarkdownPath(taskEntry.taskId))
      : Promise.resolve(null);
    const readState = include.has("state")
      ? readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskEntry.taskId))
      : Promise.resolve(null);
    const readAssets = include.has("assets")
      ? readTaskAssets(driver, ref, taskEntry.taskId)
      : Promise.resolve([]);
    const readRuns = include.has("runs")
      ? readRecentTaskRuns(driver, ref, taskEntry.taskId, limits.runLimit)
      : Promise.resolve([]);
    const readRunMarkdown = include.has("markdown")
      ? readRecentTaskRunMarkdown(driver, ref, taskEntry.taskId, limits.runLimit, limits.runMarkdownCharLimit)
      : Promise.resolve([]);
    const readActions = include.has("actions")
      ? readRecentTaskActions(driver, ref, taskEntry.taskId, limits.actionRunLimit, limits.actionLimit)
      : Promise.resolve([]);
    const readCommits = include.has("commits")
      ? readCompactLog(driver, ref, limits.commitLogLimit)
      : Promise.resolve([]);
    const readEvidence = include.has("evidence")
      ? readRecentTaskEvidence(driver, ref, taskEntry.taskId, limits.evidenceLimit)
      : Promise.resolve([]);
    const readConversationMarkdown = include.has("conversation")
      ? readTaskConversationMarkdownTail(driver, ref, input.sessionId, taskEntry.taskId, limits.conversationMarkdownCharLimit)
      : Promise.resolve("");

    const [taskMarkdown, state, assets, recentRuns, recentRunMarkdown, recentActions, recentCommits, recentEvidence, conversationMarkdownTail] = await Promise.all([
      readTaskMarkdown,
      readState,
      readAssets,
      readRuns,
      readRunMarkdown,
      readActions,
      readCommits,
      readEvidence,
      readConversationMarkdown,
    ]);

    const task = parseGitMemoryTaskMarkdown(taskMarkdown);
    if (include.has("task") && task) {
      detail.task = task;
    }
    if (include.has("markdown")) {
      detail.taskMarkdown = markdownTail(taskMarkdown, limits.taskMarkdownCharLimit);
      detail.recentRunMarkdown = recentRunMarkdown;
    }
    if (include.has("state") && state) {
      detail.state = state;
    }
    if (include.has("assets")) {
      detail.assets = assets;
    }
    if (include.has("runs")) {
      detail.recentRuns = recentRuns;
    }
    if (include.has("actions")) {
      detail.recentActions = recentActions;
    }
    if (include.has("commits")) {
      detail.recentCommits = recentCommits;
    }
    if (include.has("evidence")) {
      detail.recentEvidence = recentEvidence;
    }
    if (include.has("conversation")) {
      detail.conversationMarkdownTail = conversationMarkdownTail;
    }

    return detail;
  }

  async readSessionLog(input: ReadGitMemorySessionLogInput): Promise<GitMemorySessionLog> {
    const driver = await this.openExistingDriver(input.sessionId);
    const limit = normalizeReadLimit(input.limit, 20);
    if (input.target === "main") {
      return {
        sessionId: input.sessionId,
        target: "main",
        ref: GIT_MEMORY_MAIN_REF,
        commits: await readCompactLog(driver, GIT_MEMORY_MAIN_REF, limit),
      };
    }

    const taskEntry = await resolveGitMemoryTaskEntry(driver, input);
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    return {
      sessionId: input.sessionId,
      target: "task",
      taskId: taskEntry.taskId,
      branch: taskEntry.branch,
      ref,
      commits: await readCompactLog(driver, ref, limit),
    };
  }

  async searchTasks(input: SearchGitMemoryTasksInput): Promise<GitMemoryTaskSearchResult> {
    const driver = await this.openExistingDriver(input.sessionId);
    const query = input.query.trim();
    if (!query) {
      throw new Error("Git memory task search query is required.");
    }
    const limit = normalizeReadLimit(input.limit, 5);
    const documents = await readTaskSearchDocumentsFromDriver(driver, input.sessionId);
    const queryTokens = tokenizeSearchText(query);
    const matches = documents
      .filter((document) => !input.status || document.task.status === input.status)
      .map((document) => scoreTaskSearchMatch(document, query, queryTokens))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.taskId.localeCompare(right.taskId))
      .slice(0, limit);

    return {
      sessionId: input.sessionId,
      query,
      ...(input.status ? { status: input.status } : {}),
      matches,
    };
  }

  async readEvidence(input: ReadGitMemoryEvidenceInput): Promise<GitMemoryTaskEvidenceResult> {
    const driver = await this.openExistingDriver(input.sessionId);
    const taskEntry = await resolveGitMemoryTaskEntry(driver, input);
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    const limit = normalizeReadLimit(input.limit, 20);
    const evidence = input.runId
      ? await readTaskEvidenceForRun(driver, ref, taskEntry.taskId, input.runId, limit)
      : await readRecentTaskEvidence(driver, ref, taskEntry.taskId, limit);

    return {
      sessionId: input.sessionId,
      taskId: taskEntry.taskId,
      branch: taskEntry.branch,
      ref,
      ...(input.runId ? { runId: input.runId } : {}),
      evidence,
    };
  }

  async searchEvidence(input: SearchGitMemoryEvidenceInput): Promise<GitMemoryEvidenceSearchResult> {
    const driver = await this.openExistingDriver(input.sessionId);
    const query = input.query.trim();
    if (!query) {
      throw new Error("Git memory evidence search query is required.");
    }
    const hasTaskSelector = Boolean(input.taskId?.trim() || input.branch?.trim());
    const taskEntries = hasTaskSelector
      ? [await resolveGitMemoryTaskEntry(driver, input)]
      : await readGitMemoryTaskEntries(driver);
    const queryTokens = tokenizeSearchText(query);
    const limit = normalizeReadLimit(input.limit, 10);
    const matches: GitMemoryEvidenceSearchMatch[] = [];

    for (const taskEntry of taskEntries) {
      const ref = `refs/heads/${taskEntry.branch}`;
      if (!(await driver.hasRef(ref))) {
        if (hasTaskSelector) {
          throw new Error(`Git memory task branch missing: ${ref}`);
        }
        continue;
      }
      const evidence = await readAllTaskEvidence(driver, ref, taskEntry.taskId);
      matches.push(...evidence
        .map((record) => scoreEvidenceSearchMatch({
          sessionId: input.sessionId,
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          evidence: record,
        }, query, queryTokens))
        .filter((match) => match.score > 0));
    }

    matches.sort((left, right) =>
      right.score - left.score
      || right.evidence.runId.localeCompare(left.evidence.runId)
      || left.taskId.localeCompare(right.taskId));

    return {
      sessionId: input.sessionId,
      query,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      matches: matches.slice(0, limit),
    };
  }

  async createTaskBranch(input: CreateGitMemoryTaskBranchInput): Promise<CreateGitMemoryTaskBranchResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const tasks = await readGitMemoryTaskEntries(driver);
    const taskId = input.taskId ?? createGitMemoryTaskId(date, nextGitMemoryTaskSequence(tasks));
    if (tasks.some((task) => task.taskId === taskId)) {
      throw new Error(`Git memory task already exists: ${taskId}`);
    }
    const branch = buildGitMemoryTaskBranchName(taskId, input.title);
    const ref = buildGitMemoryTaskBranchRef(taskId, input.title);
    if (await driver.hasRef(ref)) {
      throw new Error(`Git memory task branch already exists: ${ref}`);
    }

    const at = input.at ?? this.nowIso();
    const status = input.status ?? "open";
    const task: GitMemoryTaskMarkdownFile = {
      taskId,
      title: input.title,
      objective: input.objective,
      status,
      createdAt: at,
      updatedAt: at,
    };
    const state: GitMemoryTaskStateFile = {
      schemaVersion: 1,
      status: input.state?.status ?? status,
      summary: input.state?.summary ?? input.objective,
      completed: input.state?.completed ?? [],
      open: input.state?.open ?? [input.objective],
      blockers: input.state?.blockers ?? [],
      facts: input.state?.facts ?? [],
      next: input.state?.next ?? input.objective,
      updatedAt: at,
    };
    const parentRef = await resolveTaskBranchParentRef(driver, input.sessionId);

    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      parentRef,
      files: {
        [gitMemoryTaskMarkdownPath(taskId)]: renderGitMemoryTaskMarkdown(task),
        [gitMemoryTaskStatePath(taskId)]: prettyJson(state),
        [gitMemoryTaskAssetsPath(taskId)]: prettyJson({ schemaVersion: 1, assets: [] } satisfies GitMemoryTaskAssetsFile),
        [gitMemoryTaskNotesPath(taskId)]: renderGitMemoryTaskNotes({
          taskId,
          branch,
          title: task.title,
          objective: task.objective,
          status,
          state,
          updatedAt: at,
        }),
        [gitMemoryTaskContextPath(taskId)]: "",
      },
      message: renderGitMemoryCommitMessage({
        subject: `ayati: create task ${taskId}`,
        summary: input.objective,
        trailers: {
          sessionId: input.sessionId,
          taskId,
          ...(input.runId ? { runId: input.runId } : {}),
          event: "task_created",
          status,
          at,
          branch,
          conversationSeq: { fromSeq: input.fromSeq, toSeq: input.toSeq },
          schemaVersion: 1,
        },
      }),
    });

    await driver.checkoutBranch(ref);
    await writeGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(input.sessionId), taskCommit);
    await writeGitMemoryCustomRef(driver, gitMemorySessionTaskRef(input.sessionId, taskId), taskCommit);

    return { taskId, branch, ref, title: task.title, objective: task.objective, status, state, taskCommit };
  }

  async selectTaskForTurn(input: SelectGitMemoryTaskForTurnInput): Promise<SelectGitMemoryTaskForTurnResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const taskEntry = await resolveGitMemoryTaskEntry(driver, { taskId: input.taskId });
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }

    const currentBranch = await driver.currentBranch();
    const focusChanged = currentBranch !== taskEntry.branch;
    if (focusChanged) {
      await driver.checkoutBranch(ref);
    }
    await writeGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(input.sessionId), ref);
    await writeGitMemoryCustomRef(driver, gitMemorySessionTaskRef(input.sessionId, input.taskId), ref);

    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
    };
  }

  async commitSessionStoreSnapshot(
    input: CommitGitMemorySessionStoreSnapshotInput,
  ): Promise<CommitGitMemorySessionStoreSnapshotResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const at = input.at ?? this.nowIso();
    const sessionsPath = join(messageStore.repoPath, "sessions");
    const existingSessionStoreCommit = await messageStore.resolveRef(GIT_MEMORY_MAIN_REF);
    const sessionStoreCommit = (await pathExists(sessionsPath)
      ? await messageStore.commitPaths(["sessions"], renderGitMemoryCommitMessage({
        subject: `ayati: snapshot session conversation ${input.sessionId}`,
        summary: input.summary ?? "Commit session conversation messages for task-run snapshot.",
        trailers: {
          sessionId: input.sessionId,
          event: "conversation_appended",
          at,
          schemaVersion: 1,
        },
      }))
      : null) ?? existingSessionStoreCommit;
    if (!sessionStoreCommit) {
      if (!(await pathExists(sessionsPath))) {
        throw new Error(`Git memory session-store has no conversation messages for session: ${input.sessionId}`);
      }
      throw new Error(`Git memory session-store commit is missing for session: ${input.sessionId}`);
    }

    const parentCommit = await driver.resolveRef(GIT_MEMORY_MAIN_REF);
    if (!parentCommit) {
      throw new Error(`Git memory parent commit is missing for session-store snapshot: ${input.sessionId}`);
    }

    return {
      sessionStoreCommit,
      parentCommit,
    };
  }

  async writeSessionSummary(
    input: WriteGitMemorySessionSummaryInput,
  ): Promise<WriteGitMemorySessionSummaryResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const updatedAt = input.updatedAt ?? this.nowIso();
    const metadata: GitMemorySessionSummaryMetaFile = {
      schemaVersion: 1,
      formatVersion: 1,
      sessionId: input.sessionId,
      updatedAt,
      ...(input.strategy ? { strategy: input.strategy } : {}),
      ...(typeof input.coveredUntilSeq === "number" ? { coveredUntilSeq: input.coveredUntilSeq } : {}),
      ...(typeof input.messageCount === "number" ? { messageCount: input.messageCount } : {}),
      ...(typeof input.sourceFromSeq === "number" ? { sourceFromSeq: input.sourceFromSeq } : {}),
      ...(typeof input.sourceToSeq === "number" ? { sourceToSeq: input.sourceToSeq } : {}),
      ...(typeof input.previousCoveredUntilSeq === "number" ? { previousCoveredUntilSeq: input.previousCoveredUntilSeq } : {}),
    };
    const markdownPath = gitMemorySessionStoreSummaryMarkdownPath(input.sessionId);
    const metadataPath = gitMemorySessionStoreSummaryMetaPath(input.sessionId);
    await messageStore.writeWorkingFiles({
      [markdownPath]: renderGitMemorySessionSummaryMarkdown(input.text),
      [metadataPath]: renderGitMemorySessionSummaryMetadata(metadata),
    });
    const sessionStoreCommit = await messageStore.commitPaths([markdownPath, metadataPath], renderGitMemoryCommitMessage({
      subject: `ayati: update session summary ${input.sessionId}`,
      summary: input.commitSummary ?? "Write the compact session summary files.",
      trailers: {
        sessionId: input.sessionId,
        event: "session_checkpointed",
        at: updatedAt,
        schemaVersion: 1,
      },
    })) ?? await messageStore.resolveRef(GIT_MEMORY_MAIN_REF);
    if (!sessionStoreCommit) {
      throw new Error(`Git memory session-store commit is missing after summary update: ${input.sessionId}`);
    }
    return {
      sessionStoreCommit,
      metadata,
    };
  }

  async commitTaskRun(input: CommitGitMemoryTaskRunInput): Promise<CommitGitMemoryTaskRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const taskEntry = await resolveGitMemoryTaskEntry(driver, { taskId: input.taskId });
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }

    const runId = input.runId ?? createGitMemoryRunId(date, await nextRunSequenceFromTasks(driver));
    const existingRun = await driver.readFile(ref, gitMemoryTaskRunPath(input.taskId, runId));
    if (existingRun !== null) {
      throw new Error(`Git memory task run already committed: ${runId}`);
    }
    const completedAt = input.completedAt ?? this.nowIso();
    const startedAt = input.startedAt ?? completedAt;
    const previousState = parseJson<GitMemoryTaskStateFile>(
      await driver.readFile(ref, gitMemoryTaskStatePath(input.taskId)),
    );
    if (!previousState) {
      throw new Error(`Git memory task state missing for ${input.taskId}`);
    }

    const actions = (input.actions ?? []).map((action, index): GitMemoryActionRecord => ({
      v: 1,
      actionId: action.actionId ?? createGitMemoryActionId(date, actionSequenceForRun(runId, index)),
      runId,
      tool: action.tool,
      status: action.status,
      summary: action.summary,
      startedAt: action.startedAt ?? startedAt,
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
      ...(action.evidenceRef ? { evidenceRef: action.evidenceRef } : {}),
    }));
    const evidence = buildEvidenceManifestRecords({
      taskId: input.taskId,
      runId,
      actions,
      evidence: input.evidence,
    });
    const existingAssets = await readTaskAssets(driver, ref, input.taskId);
    const mergedAssets = mergeTaskAssets(existingAssets, input.assets ?? []);
    const newFacts = input.newFacts ?? [];
    const updatedState: GitMemoryTaskStateFile = {
      schemaVersion: 1,
      status: input.state?.status ?? previousState.status,
      summary: input.state?.summary ?? input.summary,
      completed: input.state?.completed ?? previousState.completed,
      open: input.state?.open ?? previousState.open,
      blockers: input.state?.blockers ?? previousState.blockers,
      facts: input.state?.facts ?? unique([...previousState.facts, ...newFacts]),
      next: input.state?.next ?? input.next ?? previousState.next,
      updatedAt: completedAt,
    };
    const workPerformed = normalizeMemoryList(input.workPerformed)
      ?? normalizeMemoryList(updatedState.completed)
      ?? actionSummaries(actions);
    const verification = normalizeMemoryList(input.verification)
      ?? evidenceSummaries(evidence)
      ?? actionVerificationSummaries(actions);
    const blockers = normalizeMemoryList(input.blockers)
      ?? normalizeMemoryList(updatedState.blockers)
      ?? [];
    const decisions = normalizeMemoryList(input.decisions) ?? [];
    const next = input.next ?? updatedState.next;
    const outcome = input.outcome ?? defaultRunOutcome(input.status, input.summary);
    const noteFiles = taskNoteFiles(input.changedFiles ?? [], evidence, mergedAssets);
    const noteRecentWork = unique([
      ...workPerformed,
      ...(evidenceSummaries(evidence) ?? []),
    ]);
    const run: GitMemoryRunFile = {
      schemaVersion: 1,
      runId,
      taskId: input.taskId,
      status: input.status,
      startedAt,
      completedAt,
      conversationRefs: input.conversationRefs,
      ...(input.sessionStoreCommit ? { sessionStoreCommit: input.sessionStoreCommit } : {}),
      summary: input.summary,
      intent: input.intent ?? input.summary,
      routing: input.routing ?? formatConversationRefs(input.conversationRefs),
      outcome,
      ...(workPerformed.length > 0 ? { workPerformed } : {}),
      ...(verification.length > 0 ? { verification } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(blockers.length > 0 ? { blockers } : {}),
      ...(input.assistantResponse ? { assistantResponse: input.assistantResponse } : {}),
      toolCallCount: input.toolCallCount ?? actions.length,
      changedFiles: input.changedFiles ?? [],
      newFacts,
      ...(next ? { next } : {}),
    };
    const firstConversationRef = input.conversationRefs[0];
    const files: Record<string, string> = {
      [gitMemoryTaskStatePath(input.taskId)]: prettyJson(updatedState),
      [gitMemoryTaskRunPath(input.taskId, runId)]: prettyJson(run),
      [gitMemoryTaskRunMarkdownPath(input.taskId, runId)]: renderTaskRunMarkdown(run, actions, evidence),
      [gitMemoryTaskActionsPath(input.taskId, runId)]: jsonl(actions),
      [gitMemoryTaskEvidenceManifestPath(input.taskId, runId)]: jsonl(evidence),
      [gitMemoryTaskNotesPath(input.taskId)]: renderGitMemoryTaskNotes({
        taskId: input.taskId,
        branch: taskEntry.branch,
        title: taskEntry.title,
        objective: taskEntry.objective,
        status: taskEntry.status,
        state: updatedState,
        latestRun: run,
        updatedAt: completedAt,
        files: noteFiles,
        recentWork: noteRecentWork,
      }),
    };
    if (!sameTaskAssets(existingAssets, mergedAssets)) {
      files[gitMemoryTaskAssetsPath(input.taskId)] = prettyJson({
        schemaVersion: 1,
        assets: mergedAssets,
      } satisfies GitMemoryTaskAssetsFile);
    }
    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      ...(input.sessionStoreCommit ? { gitlinks: { [GIT_MEMORY_SESSION_STORE_DIR]: input.sessionStoreCommit } } : {}),
      files,
      message: renderGitMemoryCommitMessage({
        subject: `ayati: complete run ${runId}`,
        summary: input.summary,
        outcome,
        workPerformed,
        verification,
        completed: updatedState.completed,
        open: updatedState.open,
        next,
        trailers: {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId,
          event: input.status === "failed" ? "run_failed" : "run_completed",
          status: input.status,
          at: completedAt,
          branch: taskEntry.branch,
          ...(firstConversationRef ? { conversationSeq: firstConversationRef } : {}),
          schemaVersion: 1,
          extras: actions.length > 0
            ? { "Action-Id": actions.map((action) => action.actionId) }
            : undefined,
        },
      }),
    });
    await writeGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(input.sessionId), taskCommit);
    await writeGitMemoryCustomRef(driver, gitMemorySessionLatestRunRef(input.sessionId), taskCommit);
    await writeGitMemoryCustomRef(driver, gitMemorySessionTaskRef(input.sessionId, input.taskId), taskCommit);
    await writeGitMemoryCustomRef(driver, gitMemoryTaskLatestRunRef(input.taskId), taskCommit);

    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
      runId,
      taskCommit,
      ...(input.sessionStoreCommit ? { sessionStoreCommit: input.sessionStoreCommit } : {}),
    };
  }

  async readCommittedTaskRun(
    input: ReadCommittedGitMemoryTaskRunInput,
  ): Promise<CommitGitMemoryTaskRunResult | null> {
    const driver = await this.openExistingDriver(input.sessionId);
    const taskEntry = await resolveGitMemoryTaskEntry(driver, { taskId: input.taskId });
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    const existingRun = await driver.readFile(ref, gitMemoryTaskRunPath(input.taskId, input.runId));
    if (existingRun === null) {
      return null;
    }
    const runFile = parseJson<GitMemoryRunFile>(existingRun);
    const commit = (await readCompactLog(driver, ref, 100))
      .find((entry) =>
        entry.trailers.taskId === input.taskId
        && entry.trailers.runId === input.runId
        && (entry.trailers.event === "run_completed" || entry.trailers.event === "run_failed"))?.commit
      ?? await driver.resolveRef(ref);
    if (!commit) {
      throw new Error(`Git memory committed run is missing a task commit: ${input.runId}`);
    }
    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
      runId: input.runId,
      taskCommit: commit,
      ...(runFile?.sessionStoreCommit ? { sessionStoreCommit: runFile.sessionStoreCommit } : {}),
    };
  }

  async checkpointSession(input: GitMemorySessionCheckpointInput): Promise<GitMemorySessionCheckpoint> {
    const snapshot = await this.commitSessionStoreSnapshot({
      sessionId: input.sessionId,
      at: input.at,
      summary: input.summary,
    });
    return { commit: snapshot.sessionStoreCommit };
  }

  private async ensureSessionStoreInitialized(
    driver: GitMemoryWorktreeGitDriver,
    input: BuildInitialSessionFilesInput,
  ): Promise<string> {
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const existing = await messageStore.resolveRef(GIT_MEMORY_MAIN_REF);
    if (existing) {
      return existing;
    }
    const commit = await messageStore.commitFiles({
      files: buildInitialSessionStoreFiles(input),
      message: renderGitMemoryCommitMessage({
        subject: `ayati: initialize session-store ${input.sessionId}`,
        summary: "Create canonical session metadata in the session-store repo.",
        trailers: {
          sessionId: input.sessionId,
          event: "session_initialized",
          at: input.createdAt,
          schemaVersion: 1,
        },
      }),
    });
    return commit;
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

interface BuildInitialSessionFilesInput {
  sessionId: GitMemorySessionId;
  date: string;
  timezone: string;
  agentId: string;
  createdAt: string;
}

function buildInitialSessionStoreFiles(input: BuildInitialSessionFilesInput): Record<string, string> {
  const meta: GitMemorySessionMetaFile = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    date: input.date,
    timezone: input.timezone,
    createdAt: input.createdAt,
    repoKind: "daily_session",
    agentId: input.agentId,
  };
  return {
    [gitMemorySessionStoreMetaPath(input.sessionId)]: prettyJson(meta),
    [gitMemorySessionStoreSchemaPath(input.sessionId)]: prettyJson({
      schemaVersion: 1,
      kind: "git_memory_session",
      sourceOfTruth: "session_store",
      commitPolicy: "task_run_snapshot",
    }),
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl<T>(records: T[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function renderTaskRunMarkdown(
  run: GitMemoryRunFile,
  actions: GitMemoryActionRecord[],
  evidence: GitMemoryEvidenceManifestRecord[],
): string {
  return [
    `# Run ${run.runId}`,
    "",
    `Task: ${run.taskId}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    ...(run.completedAt ? [`Completed: ${run.completedAt}`] : []),
    ...(run.sessionStoreCommit ? [`Session Store Commit: ${run.sessionStoreCommit}`] : []),
    "",
    renderMarkdownParagraph("Intent", run.intent ?? run.summary),
    renderMarkdownParagraph("Routing", run.routing ?? formatConversationRefs(run.conversationRefs)),
    renderMarkdownParagraph("Outcome", run.outcome ?? defaultRunOutcome(run.status, run.summary)),
    renderMarkdownList("Work Performed", run.workPerformed ?? []),
    renderMarkdownList("Changed Files", run.changedFiles),
    renderMarkdownList("Verification", run.verification ?? []),
    renderEvidenceMarkdown(evidence),
    renderMarkdownList("Decisions", run.decisions ?? []),
    renderMarkdownList("Blockers", run.blockers ?? []),
    renderMarkdownParagraph("Next", run.next ?? "No next step."),
    renderMarkdownList("New Facts", run.newFacts),
    renderActionMarkdown(actions),
  ].join("\n");
}

function renderActionMarkdown(actions: GitMemoryActionRecord[]): string {
  if (actions.length === 0) {
    return "## Actions\n\nNone.\n";
  }
  return [
    "## Actions",
    "",
    ...actions.map((action) => [
      `- ${action.actionId} ${action.tool} ${action.status}: ${action.summary}`,
      ...(action.evidenceRef ? [`  Evidence: ${action.evidenceRef}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderEvidenceMarkdown(evidence: GitMemoryEvidenceManifestRecord[]): string {
  if (evidence.length === 0) {
    return "## Evidence\n\nNone.\n";
  }
  return [
    "## Evidence",
    "",
    ...evidence.map((record) => [
      `- ${record.tool}: ${record.summary}`,
      ...(record.evidenceRef ? [`  Ref: ${record.evidenceRef}`] : []),
      ...(record.artifacts.length > 0 ? [`  Artifacts: ${record.artifacts.join(", ")}`] : []),
      ...(record.facts.length > 0 ? [`  Facts: ${record.facts.join("; ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderMarkdownParagraph(title: string, value: string): string {
  const text = value.trim() || "None.";
  return [
    `## ${title}`,
    "",
    text,
    "",
  ].join("\n");
}

function renderMarkdownList(title: string, items: string[]): string {
  if (items.length === 0) {
    return `## ${title}\n\nNone.\n`;
  }
  return [
    `## ${title}`,
    "",
    ...items.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function normalizeMemoryList(values: string[] | undefined): string[] | undefined {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? unique(normalized) : undefined;
}

function actionSummaries(actions: GitMemoryActionRecord[]): string[] {
  return unique(actions
    .filter((action) => action.status === "completed")
    .map((action) => action.summary.trim())
    .filter(Boolean));
}

function actionVerificationSummaries(actions: GitMemoryActionRecord[]): string[] {
  return unique(actions
    .filter((action) => action.evidenceRef)
    .map((action) => `${action.tool}: ${action.evidenceRef}`)
    .filter(Boolean));
}

function evidenceSummaries(evidence: GitMemoryEvidenceManifestRecord[]): string[] | undefined {
  const summaries = unique(evidence
    .map((record) => record.summary.trim())
    .filter(Boolean));
  return summaries.length > 0 ? summaries : undefined;
}

function taskNoteFiles(
  changedFiles: string[],
  evidence: GitMemoryEvidenceManifestRecord[],
  assets: TaskAssetRecord[],
): string[] {
  return unique([
    ...changedFiles,
    ...evidence.flatMap((record) => record.artifacts),
    ...assets.map((asset) => asset.path ?? asset.name ?? "").filter(Boolean),
  ].map((value) => value.trim()).filter(Boolean));
}

function defaultRunOutcome(status: GitMemoryRunStatus, summary: string): string {
  const normalizedSummary = summary.trim();
  if (status === "completed") {
    return normalizedSummary || "Run completed.";
  }
  if (status === "failed") {
    return normalizedSummary ? `Run failed: ${normalizedSummary}` : "Run failed.";
  }
  if (status === "blocked") {
    return normalizedSummary ? `Run blocked: ${normalizedSummary}` : "Run blocked.";
  }
  return normalizedSummary ? `Needs user input: ${normalizedSummary}` : "Needs user input.";
}

function formatConversationRefs(refs: GitMemoryConversationSeqRange[]): string {
  if (refs.length === 0) {
    return "No conversation range recorded.";
  }
  return refs.map((ref) => `conversation ${ref.fromSeq}-${ref.toSeq}`).join(", ");
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

function parseJson<T>(value: string | null): T | null {
  if (!value?.trim()) {
    return null;
  }
  return JSON.parse(value) as T;
}

async function readWorkingConversation(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryConversationRecord[]> {
  const markdown = await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)
    ?? await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH);
  return parseGitMemoryConversationMarkdown(markdown);
}

async function readSessionConversation(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const records = await readSessionMessageStoreConversation(driver, sessionId);
  if (records.length > 0) {
    return records;
  }
  return await readWorkingConversation(driver);
}

async function readSessionMessageStoreConversation(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return [];
  }
  const workingRecords = await readWorkingSessionMessageStoreConversation(messageStore, sessionId);
  if (workingRecords.length > 0) {
    return workingRecords;
  }
  const paths = (await messageStore.listTreePaths(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreMessagesDir(sessionId)))
    .filter((path) => path.endsWith(".md"))
    .sort();
  if (paths.length === 0) {
    return [];
  }
  return parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
    path,
    content: await messageStore.readFile(GIT_MEMORY_MAIN_REF, path),
  }))));
}

async function readWorkingSessionMessageStoreConversation(
  messageStore: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const messageDir = gitMemorySessionStoreMessagesDir(sessionId);
  const absoluteMessageDir = join(messageStore.repoPath, messageDir);
  const entries = await readdir(absoluteMessageDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${messageDir}/${entry.name}`)
    .sort();
  if (files.length === 0) {
    return [];
  }
  return parseGitMemoryConversationMessageFiles(await Promise.all(files.map(async (path) => ({
    path,
    content: await messageStore.readWorkingFile(path),
  }))));
}

async function writeSessionMessageStoreWorkingRecord(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  record: GitMemoryConversationRecord,
): Promise<void> {
  const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
  const messagePath = gitMemorySessionStoreMessagePath(sessionId, record.seq, record.role);
  await messageStore.writeWorkingFiles({
    [messagePath]: renderGitMemoryConversationMessageFile(record, { sessionId }),
  });
}

async function readSessionMessageStoreAttachments(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemorySessionAttachmentsFile | null> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return null;
  }
  const path = gitMemorySessionStoreAttachmentsPath(sessionId);
  return normalizeSessionAttachmentsFile(
    sessionId,
    parseJson<GitMemorySessionAttachmentsFile>(
      await messageStore.readWorkingFile(path)
        ?? await messageStore.readFile(GIT_MEMORY_MAIN_REF, path),
    ),
  );
}

async function writeSessionMessageStoreAttachments(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  file: GitMemorySessionAttachmentsFile,
): Promise<void> {
  const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
  await messageStore.writeWorkingFiles({
    [gitMemorySessionStoreAttachmentsPath(sessionId)]: prettyJson(file),
  });
}

async function openExistingSessionMessageStoreDriver(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryWorktreeGitDriver | null> {
  const repoPath = join(driver.repoPath, GIT_MEMORY_SESSION_STORE_DIR);
  if (!(await pathExists(join(repoPath, ".git")))) {
    return null;
  }
  return new GitMemoryWorktreeGitDriver(repoPath);
}

async function resolveTaskBranchParentRef(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<string> {
  const latestBaseRef = gitMemorySessionLatestBaseRef(sessionId);
  if (await driver.resolveRef(latestBaseRef)) {
    return latestBaseRef;
  }
  return GIT_MEMORY_MAIN_REF;
}

async function readRefJson<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readFile(ref, path));
}

async function readSessionMeta(
  driver: GitMemoryWorktreeGitDriver,
  fallbackSessionId: string,
): Promise<GitMemorySessionMetaFile | null> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  const sessionStoreMeta = messageStore
    && isGitMemorySessionId(fallbackSessionId)
    ? parseJson<GitMemorySessionMetaFile>(
      await messageStore.readFile(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreMetaPath(fallbackSessionId)),
    )
    : null;
  if (sessionStoreMeta) {
    return sessionStoreMeta;
  }
  return parseJson<GitMemorySessionMetaFile>(
    await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_META_PATH),
  );
}

async function readRefJsonl<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T[]> {
  return parseJsonl<T>(await driver.readFile(ref, path));
}

async function readTaskAssets(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<TaskAssetRecord[]> {
  const current = await readRefJson<GitMemoryTaskAssetsFile>(driver, ref, gitMemoryTaskAssetsPath(taskId));
  return Array.isArray(current?.assets) ? current.assets.filter(isTaskAssetRecord) : [];
}

function mergeTaskAssets(
  existing: TaskAssetRecord[],
  incoming: TaskAssetRecord[],
): TaskAssetRecord[] {
  const assets = new Map<string, TaskAssetRecord>();
  for (const asset of [...existing, ...incoming]) {
    assets.set(taskAssetKey(asset), asset);
  }
  return [...assets.values()];
}

function sameTaskAssets(left: TaskAssetRecord[], right: TaskAssetRecord[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskAssetKey(asset: TaskAssetRecord): string {
  return asset.assetId
    || asset.sessionAssetId
    || asset.path
    || `${asset.role}:${asset.kind}:${asset.name}`;
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

function normalizeSessionAttachmentsFile(
  sessionId: GitMemorySessionId,
  file: GitMemorySessionAttachmentsFile | null,
): GitMemorySessionAttachmentsFile | null {
  if (!file || file.schemaVersion !== 1 || file.sessionId !== sessionId) {
    return null;
  }
  return {
    schemaVersion: 1,
    sessionId,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "",
    attachments: Array.isArray(file.attachments)
      ? file.attachments.filter(isGitMemorySessionAttachmentRecord).sort(compareSessionAttachments)
      : [],
  };
}

function isGitMemorySessionAttachmentRecord(value: unknown): value is GitMemorySessionAttachmentRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionAssetId === "string"
    && record.sessionAssetId.trim().length > 0
    && typeof record.kind === "string"
    && record.kind.trim().length > 0
    && typeof record.name === "string"
    && record.name.trim().length > 0
    && typeof record.source === "string"
    && record.source.trim().length > 0
    && isSessionAttachmentStatus(record.status)
    && typeof record.createdAt === "string"
    && record.createdAt.trim().length > 0;
}

function isSessionAttachmentStatus(value: unknown): value is GitMemorySessionAttachmentRecord["status"] {
  return value === "ready" || value === "partial" || value === "failed" || value === "unsupported";
}

function compareSessionAttachments(
  left: GitMemorySessionAttachmentRecord,
  right: GitMemorySessionAttachmentRecord,
): number {
  const leftTime = left.lastUsedAt ?? left.createdAt;
  const rightTime = right.lastUsedAt ?? right.createdAt;
  return leftTime.localeCompare(rightTime) || left.sessionAssetId.localeCompare(right.sessionAssetId);
}

async function readRefMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  path: string,
  limit: number,
): Promise<string> {
  return markdownTail(await driver.readFile(ref, path), limit);
}

async function readTaskConversationMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  sessionId: GitMemorySessionId,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<string> {
  const reconstructed = await readTaskConversationFromSessionStoreMarkdownTail(driver, ref, sessionId, taskId, limit);
  if (reconstructed) {
    return reconstructed;
  }
  const paths = (await driver.listTreePaths(ref, gitMemoryTaskConversationDir(taskId)))
    .filter((path) => path.endsWith(".md"))
    .sort();
  if (paths.length === 0) {
    return readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limit);
  }
  const records = parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
    path,
    content: await driver.readFile(ref, path),
  }))));
  if (records.length === 0) {
    return readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limit);
  }
  return markdownTail(renderGitMemoryConversationMarkdownDocument(records), limit);
}

async function readTaskConversationFromSessionStoreMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  sessionId: GitMemorySessionId,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<string> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return "";
  }
  const runs = await readTaskRunsForConversation(driver, ref, taskId);
  const recordsBySeq = new Map<number, GitMemoryConversationRecord>();
  for (const run of runs) {
    if (!run.sessionStoreCommit) {
      continue;
    }
    const paths = (await messageStore.listTreePaths(run.sessionStoreCommit, gitMemorySessionStoreMessagesDir(sessionId)))
      .filter((path) => path.endsWith(".md"))
      .sort();
    const records = parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
      path,
      content: await messageStore.readFile(run.sessionStoreCommit!, path),
    }))));
    for (const record of records.filter((record) => isConversationSeqInRanges(record.seq, run.conversationRefs))) {
      recordsBySeq.set(record.seq, record);
    }
  }
  const records = [...recordsBySeq.values()].sort((left, right) => left.seq - right.seq);
  return records.length > 0
    ? markdownTail(renderGitMemoryConversationMarkdownDocument(records), limit)
    : "";
}

async function readTaskRunsForConversation(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<GitMemoryRunFile[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".json"))
    .sort();
  const runs: GitMemoryRunFile[] = [];
  for (const path of paths) {
    const run = await readRefJson<GitMemoryRunFile>(driver, ref, path);
    if (run) {
      runs.push(run);
    }
  }
  return runs;
}

function isConversationSeqInRanges(seq: number, ranges: GitMemoryConversationSeqRange[]): boolean {
  return ranges.some((range) => seq >= range.fromSeq && seq <= range.toSeq);
}

async function activeTaskFromCustomRef(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  tasks: GitMemoryDerivedTaskEntry[],
): Promise<GitMemoryDerivedTaskEntry | undefined> {
  let activeCommit: string | null;
  try {
    activeCommit = await readGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(sessionId));
  } catch {
    return undefined;
  }
  if (!activeCommit) {
    return undefined;
  }
  for (const task of tasks) {
    const taskCommit = await driver.resolveRef(task.ref);
    if (taskCommit === activeCommit) {
      return task;
    }
  }
  return undefined;
}

interface GitMemoryTaskSearchDocument {
  entry: GitMemoryDerivedTaskEntry;
  task: GitMemoryTaskRoutingSnapshotTask;
  notesMarkdown: string;
  recentWork: string[];
  searchTerms: string[];
}

async function readTaskRoutingSnapshotFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryTaskRoutingSnapshot> {
  const [documents, currentBranch] = await Promise.all([
    readTaskSearchDocumentsFromDriver(driver, sessionId),
    driver.currentBranch(),
  ]);
  const tasks = documents.map((document) => document.entry);
  const branchTask = currentBranch?.startsWith("task/")
    ? tasks.find((task) => task.branch === currentBranch)
    : undefined;
  const currentTask = await activeTaskFromCustomRef(driver, sessionId, tasks)
    ?? branchTask;
  const focus: GitMemoryTaskRoutingFocus | null = currentTask
    ? {
        activeTaskId: currentTask.taskId,
        activeBranch: currentTask.branch,
        reason: "current_branch",
      }
    : null;

  return {
    sessionId,
    focus,
    tasks: documents.map((document) => document.task),
  };
}

async function readTaskSearchDocumentsFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryTaskSearchDocument[]> {
  const taskEntries = await readGitMemorySessionTaskEntries(driver, sessionId);
  const documents: GitMemoryTaskSearchDocument[] = [];
  for (const taskEntry of taskEntries) {
    const ref = taskEntry.ref;
    if (!(await driver.hasRef(ref))) {
      const task: GitMemoryTaskRoutingSnapshotTask = {
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
        title: taskEntry.title,
        objective: taskEntry.title,
        status: taskEntry.status,
        summary: taskEntry.title,
        open: [],
        blockers: [],
        facts: [],
        next: taskEntry.title,
        missing: true,
      };
      documents.push({
        entry: taskEntry,
        task,
        notesMarkdown: "",
        recentWork: [],
        searchTerms: [],
      });
      continue;
    }

    const [taskMarkdown, state, notesMarkdown] = await Promise.all([
      driver.readFile(ref, gitMemoryTaskMarkdownPath(taskEntry.taskId)),
      parseJson<GitMemoryTaskStateFile>(
        await driver.readFile(ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      ),
      driver.readFile(ref, gitMemoryTaskNotesPath(taskEntry.taskId)),
    ]);
    const task = parseGitMemoryTaskMarkdown(taskMarkdown);
    const notes = parseTaskNotesSearchFields(notesMarkdown ?? "");
    documents.push({
      entry: taskEntry,
      task: {
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
        title: task?.title ?? taskEntry.title,
        objective: task?.objective ?? taskEntry.title,
        status: state?.status ?? taskEntry.status,
        summary: state?.summary ?? task?.objective ?? taskEntry.title,
        open: state?.open ?? [],
        blockers: state?.blockers ?? [],
        facts: state?.facts ?? [],
        next: state?.next ?? task?.objective ?? taskEntry.title,
        updatedAt: state?.updatedAt ?? taskEntry.updatedAt,
        ...(notes.latestRunId ? { latestRunId: notes.latestRunId } : {}),
        ...(notes.files.length > 0 ? { files: notes.files } : {}),
        ...(!task || !state ? { missing: true } : {}),
      },
      notesMarkdown: notesMarkdown ?? "",
      recentWork: notes.recentWork,
      searchTerms: notes.searchTerms,
    });
  }

  return documents;
}

function parseTaskNotesSearchFields(markdown: string): {
  latestRunId?: GitMemoryRunId;
  files: string[];
  recentWork: string[];
  searchTerms: string[];
} {
  const latestRunId = /^Latest Run:\s*(R-\d{8}-\d{4})$/m.exec(markdown)?.[1] as GitMemoryRunId | undefined;
  return {
    ...(latestRunId ? { latestRunId } : {}),
    files: parseMarkdownListSection(markdown, "Files"),
    recentWork: parseMarkdownListSection(markdown, "Recent Work"),
    searchTerms: parseMarkdownTextSection(markdown, "Search Terms")
      .toLowerCase()
      .split(/[^a-z0-9._/-]+/g)
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function parseMarkdownListSection(markdown: string, title: string): string[] {
  return parseMarkdownTextSection(markdown, title)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseMarkdownTextSection(markdown: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(markdown);
  return match?.[1]?.trim() ?? "";
}

async function nextRunSequenceFromTasks(driver: GitMemoryWorktreeGitDriver): Promise<number> {
  const sequences: number[] = [];
  for (const task of await readGitMemoryTaskEntries(driver)) {
    const ref = `refs/heads/${task.branch}`;
    if (!(await driver.hasRef(ref))) {
      continue;
    }
    const prefix = `${gitMemoryTaskDir(task.taskId)}/runs`;
    const paths = (await driver.listTreePaths(ref, prefix))
      .filter((path) => path.endsWith(".json"));
    for (const path of paths) {
      const sequence = runSequenceFromRunId(runIdFromRunPath(path));
      if (sequence > 0) {
        sequences.push(sequence);
      }
    }
    for (const commit of await driver.log(ref, 200)) {
      const runId = parseGitMemoryCommitTrailers(commit.message).runId;
      const sequence = runId ? runSequenceFromRunId(runId) : 0;
      if (sequence > 0) {
        sequences.push(sequence);
      }
    }
  }
  return Math.max(0, ...sequences) + 1;
}

function normalizeTaskDetailInclude(input: GitMemoryTaskDetailInclude[] | undefined): Set<GitMemoryTaskDetailInclude> {
  return new Set(input && input.length > 0
    ? input
    : ["task", "state", "runs", "markdown", "actions", "assets", "commits", "evidence", "conversation"]);
}

function normalizeTaskDetailLimits(input: Partial<GitMemoryTaskDetailLimits> | undefined): GitMemoryTaskDetailLimits {
  return {
    runLimit: normalizeReadLimit(input?.runLimit, 5),
    actionRunLimit: normalizeReadLimit(input?.actionRunLimit, 3),
    actionLimit: normalizeReadLimit(input?.actionLimit, 20),
    commitLogLimit: normalizeReadLimit(input?.commitLogLimit, 10),
    evidenceLimit: normalizeReadLimit(input?.evidenceLimit, 20),
    conversationMarkdownCharLimit: normalizeMarkdownCharLimit(input?.conversationMarkdownCharLimit, 12_000),
    taskMarkdownCharLimit: normalizeMarkdownCharLimit(input?.taskMarkdownCharLimit, 12_000),
    runMarkdownCharLimit: normalizeMarkdownCharLimit(input?.runMarkdownCharLimit, 12_000),
  };
}

async function readRecentTaskRuns(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryRunFile[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".json"))
    .sort(), limit);
  const runs: GitMemoryRunFile[] = [];
  for (const path of paths) {
    const run = await readRefJson<GitMemoryRunFile>(driver, ref, path);
    if (run) {
      runs.push(run);
    }
  }
  return runs;
}

async function readRecentTaskRunMarkdown(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
  markdownLimit: number,
): Promise<GitMemoryTaskRunMarkdown[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".md"))
    .sort(), limit);
  const records: GitMemoryTaskRunMarkdown[] = [];
  for (const path of paths) {
    records.push({
      runId: runIdFromRunMarkdownPath(path),
      path,
      markdown: await readRefMarkdownTail(driver, ref, path, markdownLimit),
    });
  }
  return records;
}

async function readRecentTaskActions(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  runLimit: number,
  actionLimit: number,
): Promise<GitMemoryTaskActionGroup[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/actions`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".jsonl"))
    .sort(), runLimit);
  const groups: GitMemoryTaskActionGroup[] = [];
  for (const path of paths) {
    groups.push({
      runId: runIdFromActionPath(path),
      path,
      actions: tail(await readRefJsonl<GitMemoryActionRecord>(driver, ref, path), actionLimit),
    });
  }
  return groups;
}

async function readRecentTaskEvidence(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  return tail(await readAllTaskEvidence(driver, ref, taskId), limit);
}

async function readAllTaskEvidence(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/evidence`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith("/manifest.jsonl"))
    .sort();
  const records: GitMemoryEvidenceManifestRecord[] = [];
  for (const path of paths) {
    records.push(...await readRefJsonl<GitMemoryEvidenceManifestRecord>(driver, ref, path));
  }
  return records;
}

async function readTaskEvidenceForRun(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  runId: GitMemoryRunId,
  limit: number,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  const path = gitMemoryTaskEvidenceManifestPath(taskId, runId);
  const raw = await driver.readFile(ref, path);
  if (raw === null) {
    throw new Error(`Git memory evidence manifest not found for run: ${runId}`);
  }
  return tail(parseJsonl<GitMemoryEvidenceManifestRecord>(raw), limit);
}

async function readCompactLog(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  limit: number,
): Promise<CompactGitMemoryStoreCommitSummary[]> {
  return (await driver.log(ref, limit)).map((entry) => {
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
  });
}

function scoreTaskSearchMatch(
  document: GitMemoryTaskSearchDocument,
  rawQuery: string,
  queryTokens: string[],
): GitMemoryTaskSearchMatch {
  const task = document.task;
  const reasons = new Set<string>();
  let score = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);

  const weightedFields: Array<{
    reason: string;
    weight: number;
    values: string[];
  }> = [
    { reason: "taskId", weight: 18, values: [task.taskId] },
    { reason: "branch", weight: 14, values: [task.branch] },
    { reason: "title", weight: 12, values: [task.title] },
    { reason: "objective", weight: 10, values: [task.objective] },
    { reason: "summary", weight: 8, values: [task.summary] },
    { reason: "next", weight: 7, values: [task.next] },
    { reason: "facts", weight: 6, values: task.facts },
    { reason: "files", weight: 11, values: task.files ?? [] },
    { reason: "recentWork", weight: 8, values: document.recentWork },
    { reason: "searchTerms", weight: 7, values: document.searchTerms },
    { reason: "open", weight: 5, values: task.open },
    { reason: "blockers", weight: 5, values: task.blockers },
    { reason: "status", weight: 3, values: [task.status] },
    { reason: "notes", weight: 2, values: [document.notesMarkdown] },
  ];

  for (const field of weightedFields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += field.weight * 3;
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.weight;
      reasons.add(field.reason);
    }
  }

  return {
    ...task,
    score,
    matchReasons: [...reasons],
  };
}

function scoreEvidenceSearchMatch(
  input: Omit<GitMemoryEvidenceSearchMatch, "score" | "matchReasons">,
  rawQuery: string,
  queryTokens: string[],
): GitMemoryEvidenceSearchMatch {
  const reasons = new Set<string>();
  let score = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);
  const record = input.evidence;
  const weightedFields: Array<{
    reason: string;
    weight: number;
    values: string[];
  }> = [
    { reason: "taskId", weight: 12, values: [input.taskId] },
    { reason: "branch", weight: 8, values: [input.branch] },
    { reason: "runId", weight: 12, values: [record.runId] },
    { reason: "actionId", weight: 12, values: record.actionId ? [record.actionId] : [] },
    { reason: "tool", weight: 10, values: [record.tool] },
    { reason: "summary", weight: 12, values: [record.summary] },
    { reason: "evidenceRef", weight: 9, values: record.evidenceRef ? [record.evidenceRef] : [] },
    { reason: "artifacts", weight: 8, values: record.artifacts },
    { reason: "facts", weight: 10, values: record.facts },
    { reason: "accessModes", weight: 3, values: record.accessModes },
  ];

  for (const field of weightedFields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += field.weight * 3;
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.weight;
      reasons.add(field.reason);
    }
  }

  return {
    ...input,
    score,
    matchReasons: [...reasons],
  };
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2)
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildEvidenceManifestRecords(input: {
  taskId: GitMemoryTaskId;
  runId: GitMemoryRunId;
  actions: GitMemoryActionRecord[];
  evidence?: CommitGitMemoryTaskRunEvidenceInput[];
}): GitMemoryEvidenceManifestRecord[] {
  if (input.evidence && input.evidence.length > 0) {
    return input.evidence.map((record): GitMemoryEvidenceManifestRecord => ({
      v: 1,
      runId: input.runId,
      taskId: input.taskId,
      ...(record.step ? { step: record.step } : {}),
      ...(record.actionId ? { actionId: record.actionId } : {}),
      tool: record.tool,
      ...(record.status ? { status: record.status } : {}),
      summary: record.summary,
      ...(record.evidenceRef ? { evidenceRef: record.evidenceRef } : {}),
      artifacts: unique(record.artifacts ?? []),
      facts: unique(record.facts ?? []),
      accessModes: unique(record.accessModes ?? []),
      ...(record.outputSize !== undefined ? { outputSize: record.outputSize } : {}),
      ...(record.lineCount !== undefined ? { lineCount: record.lineCount } : {}),
      ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
      ...(record.source ? { source: record.source } : {}),
    }));
  }

  return input.actions.map((action): GitMemoryEvidenceManifestRecord => ({
    v: 1,
    runId: input.runId,
    taskId: input.taskId,
    actionId: action.actionId,
    tool: action.tool,
    status: action.status,
    summary: action.summary,
    ...(action.evidenceRef ? { evidenceRef: action.evidenceRef } : {}),
    artifacts: [],
    facts: [],
    accessModes: action.evidenceRef ? ["summary"] : [],
    source: { kind: "git-memory-action" },
  }));
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nextSeq(records: Array<{ seq?: unknown }>): number {
  return records.reduce((max, record) => (
    typeof record.seq === "number" && Number.isInteger(record.seq) ? Math.max(max, record.seq) : max
  ), 0) + 1;
}

function normalizeReadLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, 100);
}

function normalizeMarkdownCharLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, 50_000);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runIdFromActionPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.jsonl$/, "");
}

function runIdFromRunMarkdownPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.md$/, "");
}

function runIdFromRunPath(path: string): GitMemoryRunId {
  const fileName = path.split("/").pop() ?? "";
  return fileName.replace(/\.json$/, "");
}

function runSequenceFromRunId(runId: GitMemoryRunId): number {
  const sequence = Number(runId.split("-")[2] ?? "0");
  return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
}

function actionSequenceForRun(runId: GitMemoryRunId, actionIndex: number): number {
  const runSequence = runSequenceFromRunId(runId);
  return runSequence * 100 + actionIndex + 1;
}
