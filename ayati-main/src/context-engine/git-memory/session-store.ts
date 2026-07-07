import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
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
  gitMemorySessionRunReservationRef,
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
  GitMemoryTaskStateDecision,
  GitMemoryTaskStateEvidence,
  GitMemoryTaskStateFact,
  GitMemoryTaskStateFile,
  GitMemoryTaskStateFileRecord,
  GitMemoryTaskStatus,
  GitMemoryStepRecord,
  GitMemoryStepToolCallRecord,
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
  gitMemoryTaskConversationDir,
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStepsPath,
  gitMemoryTaskStepsStagingPath,
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
  task?: GitMemoryTaskStateFile["task"];
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
  routeScore: number;
  matchReasons: string[];
  matchedArtifacts?: GitMemoryTaskSearchArtifact[];
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

export interface ReadGitMemoryRunStepInput {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  step: number;
  callId?: string;
  taskId?: GitMemoryTaskId;
  branch?: string;
}

export interface GitMemoryRunStepReadResult {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  runId: GitMemoryRunId;
  step: number;
  source: "staged" | "committed";
  record: GitMemoryStepRecord;
  toolCall?: GitMemoryStepToolCallRecord;
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
  kind?: GitMemoryConversationRecord["kind"];
  text: string;
  at?: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface AppendGitMemoryConversationRecordInput {
  sessionId: GitMemorySessionId;
  record: GitMemoryConversationRecord;
}

export interface GitMemoryTaskSearchArtifact {
  artifactId: string;
  source: GitMemoryTaskStateFileRecord["source"];
  kind: string;
  path: string;
  originalName?: string;
  role: GitMemoryTaskStateFileRecord["role"];
  status: GitMemoryTaskStateFileRecord["status"];
  identity: GitMemoryTaskStateFileRecord["identity"];
  confidence: GitMemoryTaskStateFileRecord["confidence"];
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
  artifacts?: GitMemoryTaskSearchArtifact[];
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
  state?: {
    status?: GitMemoryTaskStatus;
    summary?: string;
    completed?: string[];
    open?: string[];
    blockers?: string[];
    facts?: string[];
    next?: string;
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

export interface RecordGitMemoryTaskRunStepInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  runId: GitMemoryRunId;
  record: GitMemoryStepRecord;
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
  state?: {
    status?: GitMemoryTaskStatus;
    summary?: string;
    completed?: string[];
    open?: string[];
    blockers?: string[];
    facts?: string[];
    next?: string;
  };
  evidence?: CommitGitMemoryTaskRunEvidenceInput[];
  assets?: TaskAssetRecord[];
  steps?: GitMemoryStepRecord[];
}

export interface CommitGitMemoryTaskRunResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  runId: GitMemoryRunId;
  runStatus: GitMemoryRunStatus;
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

  async readSessionMeta(sessionId: GitMemorySessionId): Promise<GitMemorySessionMetaFile | null> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
    return await readSessionMeta(driver, sessionId);
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
      ...(input.kind ? { kind: input.kind } : {}),
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
      ...(input.kind ? { kind: input.kind } : {}),
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
    const existingRun = await driver.readFile(ref, gitMemoryTaskRunPath(input.taskId, input.runId));
    if (existingRun !== null) {
      throw new Error(`Git memory task run already finalized: ${input.runId}`);
    }
    if (await readGitMemoryCustomRef(driver, gitMemorySessionRunReservationRef(input.sessionId, input.runId))) {
      throw new Error(`Git memory task run already reserved: ${input.runId}`);
    }
    await writeGitMemoryCustomRef(driver, gitMemorySessionRunReservationRef(input.sessionId, input.runId), ref);
    return { runId: input.runId };
  }

  async appendTaskRunStep(input: RecordGitMemoryTaskRunStepInput): Promise<void> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const taskEntry = await resolveGitMemoryTaskEntry(driver, { taskId: input.taskId });
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    if (input.record.taskId !== input.taskId || input.record.runId !== input.runId) {
      throw new Error(`Git memory step record does not match task/run: ${input.taskId}/${input.runId}`);
    }
    await driver.appendWorkingFile(
      gitMemoryTaskStepsStagingPath(input.taskId, input.runId),
      `${JSON.stringify(input.record)}\n`,
    );
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

    const readState = include.has("state")
      || include.has("task")
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

    const [state, assets, recentRuns, recentRunMarkdown, recentActions, recentCommits, recentEvidence, conversationMarkdownTail] = await Promise.all([
      readState,
      readAssets,
      readRuns,
      readRunMarkdown,
      readActions,
      readCommits,
      readEvidence,
      readConversationMarkdown,
    ]);

    if (include.has("task") && state) {
      detail.task = state.task;
    }
    if (include.has("markdown")) {
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

  async readRunStep(input: ReadGitMemoryRunStepInput): Promise<GitMemoryRunStepReadResult> {
    const driver = await this.openExistingDriver(input.sessionId);
    const hasTaskSelector = Boolean(input.taskId?.trim() || input.branch?.trim());
    const taskEntries = hasTaskSelector
      ? [await resolveGitMemoryTaskEntry(driver, input)]
      : await readGitMemoryTaskEntries(driver);

    for (const taskEntry of taskEntries) {
      const ref = `refs/heads/${taskEntry.branch}`;
      if (!(await driver.hasRef(ref))) {
        if (hasTaskSelector) {
          throw new Error(`Git memory task branch missing: ${ref}`);
        }
        continue;
      }

      const staged = await readTaskRunStagedSteps(driver, taskEntry.taskId, input.runId);
      const stagedMatch = findRunStepRecord(staged, input);
      if (stagedMatch) {
        return buildRunStepReadResult({
          sessionId: input.sessionId,
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          source: "staged",
          record: stagedMatch.record,
          toolCall: stagedMatch.toolCall,
        });
      }

      const committed = await readRefJsonl<GitMemoryStepRecord>(driver, ref, gitMemoryTaskStepsPath(taskEntry.taskId, input.runId));
      const committedMatch = findRunStepRecord(committed, input);
      if (committedMatch) {
        return buildRunStepReadResult({
          sessionId: input.sessionId,
          taskId: taskEntry.taskId,
          branch: taskEntry.branch,
          ref,
          source: "committed",
          record: committedMatch.record,
          toolCall: committedMatch.toolCall,
        });
      }
    }

    const callSuffix = input.callId ? ` call ${input.callId}` : "";
    throw new Error(`Git memory run step not found: ${input.runId} step ${input.step}${callSuffix}`);
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
    const state: GitMemoryTaskStateFile = {
      schemaVersion: 2,
      task: {
        taskId,
        title: input.title,
        objective: input.objective,
        branch,
        createdAt: at,
        updatedAt: at,
      },
      status: input.state?.status ?? status,
      summary: input.state?.summary ?? input.objective,
      progress: {
        completed: input.state?.completed ?? [],
        open: input.state?.open ?? [input.objective],
        blockers: input.state?.blockers ?? [],
        next: input.state?.next ?? input.objective,
      },
      memory: {
        facts: taskStateFacts(input.state?.facts ?? []),
        decisions: [],
        evidence: [],
        files: [],
        assets: [],
      },
      runs: {
        runIds: [],
        recent: [],
      },
      context: {
        workingSummary: input.state?.summary ?? input.objective,
        importantFiles: [],
        searchTerms: deriveTaskStateSearchTerms({
          taskId,
          branch,
          title: input.title,
          objective: input.objective,
          summary: input.state?.summary ?? input.objective,
          completed: input.state?.completed ?? [],
          open: input.state?.open ?? [input.objective],
          blockers: input.state?.blockers ?? [],
          facts: input.state?.facts ?? [],
          next: input.state?.next ?? input.objective,
          files: [],
          decisions: [],
        }),
        warnings: input.state?.blockers ?? [],
      },
      updatedAt: at,
    };
    const parentRef = await resolveTaskBranchParentRef(driver, input.sessionId);

    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      parentRef,
      files: {
        [gitMemoryTaskStatePath(taskId)]: prettyJson(state),
        [gitMemoryTaskAssetsPath(taskId)]: prettyJson({ schemaVersion: 1, assets: [] } satisfies GitMemoryTaskAssetsFile),
        [gitMemoryTaskNotesPath(taskId)]: renderGitMemoryTaskNotes({
          taskId,
          branch,
          title: state.task.title,
          objective: state.task.objective,
          status,
          state,
          updatedAt: at,
        }),
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

    return { taskId, branch, ref, title: state.task.title, objective: state.task.objective, status, state, taskCommit };
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
    const stagedSteps = await readTaskRunStagedSteps(driver, input.taskId, runId);
    const steps = stagedSteps.length > 0
      ? stagedSteps
      : input.steps ?? buildStepRecordsFromLegacyEvidence({
        taskId: input.taskId,
        runId,
        actions,
        evidence,
        completedAt,
      });
    const existingAssets = await readTaskAssets(driver, ref, input.taskId);
    const mergedAssets = mergeTaskAssets(existingAssets, input.assets ?? []);
    const evidenceFacts = unique(evidence.flatMap((record) => record.facts));
    const stepFacts = unique(steps.flatMap((step) => step.facts));
    const newFacts = unique(input.newFacts ?? []);
    const stateFacts = unique([...newFacts, ...evidenceFacts, ...stepFacts]);
    const progressCompleted = input.state?.completed ?? previousState.progress.completed;
    const progressOpen = input.state?.open ?? previousState.progress.open;
    const progressBlockers = input.state?.blockers ?? previousState.progress.blockers;
    const progressNext = input.state?.next ?? input.next ?? previousState.progress.next;
    const workPerformed = normalizeMemoryList(input.workPerformed)
      ?? normalizeMemoryList(progressCompleted)
      ?? actionSummaries(actions);
    const verification = normalizeMemoryList(input.verification)
      ?? evidenceSummaries(evidence)
      ?? actionVerificationSummaries(actions);
    const blockers = normalizeMemoryList(input.blockers)
      ?? normalizeMemoryList(progressBlockers)
      ?? [];
    const decisions = normalizeMemoryList(input.decisions) ?? [];
    const next = input.next ?? progressNext;
    const outcome = input.outcome ?? defaultRunOutcome(input.status, input.summary);
    const noteFiles = taskNoteFiles(input.changedFiles ?? [], evidence, mergedAssets);
    const noteRecentWork = unique([
      ...workPerformed,
      ...(evidenceSummaries(evidence) ?? []),
    ]);
    const taskFiles = mergeTaskStateFiles(previousState.memory.files, [
      ...taskStateFiles(input.changedFiles ?? [], "modified", "changed in run", runId, {
        title: previousState.task.title,
        objective: previousState.task.objective,
        sourceTurnSeq: input.conversationRefs[0]?.fromSeq,
      }),
      ...taskStateFiles(evidence.flatMap((record) => record.artifacts), "reference", "evidence artifact", runId, {
        title: previousState.task.title,
        objective: previousState.task.objective,
        sourceTurnSeq: input.conversationRefs[0]?.fromSeq,
      }),
      ...taskStateFilesFromAssets(mergedAssets, runId, {
        title: previousState.task.title,
        objective: previousState.task.objective,
        sourceTurnSeq: input.conversationRefs[0]?.fromSeq,
      }),
    ]);
    const updatedState: GitMemoryTaskStateFile = {
      schemaVersion: 2,
      task: {
        ...previousState.task,
        updatedAt: completedAt,
      },
      status: input.state?.status ?? previousState.status,
      summary: input.state?.summary ?? input.summary,
      progress: {
        completed: progressCompleted,
        open: progressOpen,
        blockers: progressBlockers,
        next: progressNext,
      },
      memory: {
        facts: mergeTaskStateFacts(
          previousState.memory.facts,
          taskStateFacts(input.state?.facts ?? stateFacts, runId, "verified"),
        ),
        decisions: mergeTaskStateDecisions(
          previousState.memory.decisions,
          taskStateDecisions(decisions, runId),
        ),
        evidence: mergeTaskStateEvidence(
          previousState.memory.evidence,
          taskStateEvidence(evidence, runId),
        ),
        files: taskFiles,
        assets: mergedAssets,
      },
      runs: {
        latestRunId: runId,
        runIds: unique([...previousState.runs.runIds, runId]),
        recent: tail([
          ...previousState.runs.recent.filter((runSummary) => runSummary.runId !== runId),
          {
            runId,
            status: input.status,
            summary: input.summary,
            outcome,
            completedAt,
            changedFiles: input.changedFiles ?? [],
            ...(next ? { next } : {}),
          },
        ], 10),
      },
      context: {
        workingSummary: input.state?.summary ?? input.summary,
        importantFiles: tail(unique([
          ...previousState.context.importantFiles,
          ...noteFiles,
        ]), 40),
        searchTerms: deriveTaskStateSearchTerms({
          taskId: input.taskId,
          branch: taskEntry.branch,
          title: previousState.task.title,
          objective: previousState.task.objective,
          summary: input.state?.summary ?? input.summary,
          completed: progressCompleted,
          open: progressOpen,
          blockers: progressBlockers,
          facts: mergeTaskStateFacts(
            previousState.memory.facts,
            taskStateFacts(input.state?.facts ?? stateFacts, runId, "verified"),
          ).map((fact) => fact.text),
          next,
          files: [
            ...noteFiles,
            ...taskFiles.flatMap(taskStateFileSearchTerms),
          ],
          decisions,
        }),
        warnings: progressBlockers,
      },
      updatedAt: completedAt,
    };
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
      [gitMemoryTaskRunMarkdownPath(input.taskId, runId)]: renderTaskRunMarkdown(run, steps),
      [gitMemoryTaskStepsPath(input.taskId, runId)]: jsonl(steps),
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
        completed: updatedState.progress.completed,
        open: updatedState.progress.open,
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
    await driver.removeWorkingFile(gitMemoryTaskStepsStagingPath(input.taskId, runId));

    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
      runId,
      runStatus: run.status,
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
    if (!runFile) {
      throw new Error(`Git memory committed run file is invalid: ${input.runId}`);
    }
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
      runStatus: runFile.status,
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
  steps: GitMemoryStepRecord[],
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
    renderStepEvidenceMarkdown(steps),
    renderMarkdownList("Decisions", run.decisions ?? []),
    renderMarkdownList("Blockers", run.blockers ?? []),
    renderMarkdownParagraph("Next", run.next ?? "No next step."),
    renderMarkdownList("New Facts", run.newFacts),
    renderStepActionMarkdown(steps),
  ].join("\n");
}

function renderStepActionMarkdown(steps: GitMemoryStepRecord[]): string {
  if (steps.length === 0) {
    return "## Actions\n\nNone.\n";
  }
  return [
    "## Actions",
    "",
    ...steps.map((step) => [
      `- Step ${step.step} ${step.status}: ${step.summary}`,
      ...(step.action?.["executionContract"] ? [`  Contract: ${String(step.action["executionContract"])}`] : []),
      ...(step.toolCalls.length > 0 ? [`  Tools: ${unique(step.toolCalls.map((call) => call.tool)).join(", ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderStepEvidenceMarkdown(steps: GitMemoryStepRecord[]): string {
  if (steps.length === 0) {
    return "## Evidence\n\nNone.\n";
  }
  return [
    "## Evidence",
    "",
    ...steps.map((record) => [
      `- Step ${record.step}: ${record.verification.evidenceSummary ?? record.verification.summary}`,
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

function taskStateFacts(
  values: string[],
  sourceRunId?: GitMemoryRunId,
  confidence: GitMemoryTaskStateFact["confidence"] = "observed",
): GitMemoryTaskStateFact[] {
  return unique(values)
    .map((text) => ({
      text,
      ...(sourceRunId ? { sourceRunId } : {}),
      confidence,
    }));
}

function mergeTaskStateFacts(
  existing: GitMemoryTaskStateFact[],
  incoming: GitMemoryTaskStateFact[],
): GitMemoryTaskStateFact[] {
  const facts = new Map<string, GitMemoryTaskStateFact>();
  for (const fact of [...existing, ...incoming]) {
    facts.set(fact.text.toLowerCase(), fact);
  }
  return [...facts.values()];
}

function taskStateDecisions(values: string[], sourceRunId: GitMemoryRunId): GitMemoryTaskStateDecision[] {
  return unique(values).map((text) => ({ text, sourceRunId }));
}

function mergeTaskStateDecisions(
  existing: GitMemoryTaskStateDecision[],
  incoming: GitMemoryTaskStateDecision[],
): GitMemoryTaskStateDecision[] {
  const decisions = new Map<string, GitMemoryTaskStateDecision>();
  for (const decision of [...existing, ...incoming]) {
    decisions.set(decision.text.toLowerCase(), decision);
  }
  return [...decisions.values()];
}

function taskStateEvidence(
  evidence: GitMemoryEvidenceManifestRecord[],
  sourceRunId: GitMemoryRunId,
): GitMemoryTaskStateEvidence[] {
  return evidence
    .map((record) => ({
      summary: record.summary,
      sourceRunId,
      ...(record.step ? { sourceStep: record.step } : {}),
      artifacts: record.artifacts,
      facts: record.facts,
    }))
    .filter((record) => record.summary.trim().length > 0);
}

function mergeTaskStateEvidence(
  existing: GitMemoryTaskStateEvidence[],
  incoming: GitMemoryTaskStateEvidence[],
): GitMemoryTaskStateEvidence[] {
  const evidence = new Map<string, GitMemoryTaskStateEvidence>();
  for (const record of [...existing, ...incoming]) {
    evidence.set(`${record.sourceRunId ?? ""}:${record.sourceStep ?? ""}:${record.summary.toLowerCase()}`, record);
  }
  return [...evidence.values()];
}

function taskStateFiles(
  paths: string[],
  role: GitMemoryTaskStateFileRecord["role"],
  reason: string,
  sourceRunId: GitMemoryRunId,
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord[] {
  return unique(paths)
    .map((path) => taskStateFileRecord({
      source: "agent_workspace",
      kind: inferArtifactKind(path),
      path,
      role,
      reason,
      sourceRunId,
      lastTouchedRunId: sourceRunId,
      confidence: "verified",
    }, context));
}

function taskStateFilesFromAssets(
  assets: TaskAssetRecord[],
  sourceRunId: GitMemoryRunId,
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord[] {
  return assets
    .map((asset) => taskStateFileRecord({
      source: isUserAttachmentAsset(asset) ? "user_attachment" : "agent_workspace",
      kind: asset.kind,
      path: asset.path ?? asset.name,
      originalName: asset.name,
      role: asset.role === "generated" ? "generated" : "reference",
      reason: asset.role === "generated" ? "generated task asset" : "task input asset",
      sourceRunId,
      ...(asset.role === "generated" ? { lastTouchedRunId: sourceRunId } : {}),
      confidence: isUserAttachmentAsset(asset) ? "user_provided" : "verified",
    }, context))
    .filter((record, index, all) => all.findIndex((candidate) => candidate.path === record.path && candidate.source === record.source) === index);
}

interface ArtifactIdentityContext {
  title: string;
  objective: string;
  sourceTurnSeq?: number;
}

function taskStateFileRecord(
  input: {
    source: GitMemoryTaskStateFileRecord["source"];
    kind: string;
    path: string;
    originalName?: string;
    mimeType?: string;
    role: GitMemoryTaskStateFileRecord["role"];
    reason: string;
    sourceRunId: GitMemoryRunId;
    lastTouchedRunId?: GitMemoryRunId;
    confidence: GitMemoryTaskStateFileRecord["confidence"];
  },
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord {
  const identity = buildArtifactIdentity({
    path: input.path,
    originalName: input.originalName,
    kind: input.kind,
    source: input.source,
    title: context.title,
    objective: context.objective,
  });
  return {
    artifactId: stableArtifactId(input.source, input.path),
    source: input.source,
    kind: input.kind,
    path: input.path,
    ...(input.originalName ? { originalName: input.originalName } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    role: input.role,
    identity,
    status: "active",
    reason: input.reason,
    ...(input.role === "generated" || input.role === "modified" ? { createdByRunId: input.sourceRunId } : {}),
    ...(input.lastTouchedRunId ? { lastTouchedRunId: input.lastTouchedRunId } : {}),
    sourceRunId: input.sourceRunId,
    ...(context.sourceTurnSeq ? { sourceTurnSeq: context.sourceTurnSeq } : {}),
    confidence: input.confidence,
  };
}

function mergeTaskStateFiles(
  existing: GitMemoryTaskStateFileRecord[],
  incoming: GitMemoryTaskStateFileRecord[],
): GitMemoryTaskStateFileRecord[] {
  const files = new Map<string, GitMemoryTaskStateFileRecord>();
  for (const file of [...existing, ...incoming]) {
    const key = `${file.source}:${file.path}`;
    const previous = files.get(key);
    files.set(key, previous ? {
      ...previous,
      ...file,
      artifactId: previous.artifactId || file.artifactId,
      role: chooseTaskFileRole(previous.role, file.role),
      reason: chooseTaskFileRole(previous.role, file.role) === previous.role ? previous.reason : file.reason,
      createdByRunId: previous.createdByRunId ?? file.createdByRunId,
      sourceRunId: file.sourceRunId ?? previous.sourceRunId,
      lastTouchedRunId: file.lastTouchedRunId ?? previous.lastTouchedRunId,
    } : file);
  }
  return [...files.values()];
}

function chooseTaskFileRole(
  previous: GitMemoryTaskStateFileRecord["role"],
  incoming: GitMemoryTaskStateFileRecord["role"],
): GitMemoryTaskStateFileRecord["role"] {
  return taskFileRolePriority(incoming) > taskFileRolePriority(previous) ? incoming : previous;
}

function taskFileRolePriority(role: GitMemoryTaskStateFileRecord["role"]): number {
  switch (role) {
    case "modified":
      return 5;
    case "created":
      return 4;
    case "generated":
      return 3;
    case "touched":
      return 2;
    case "reference":
      return 1;
  }
}

function taskStateFileSearchTerms(file: GitMemoryTaskStateFileRecord): string[] {
  return [
    file.path,
    file.originalName ?? "",
    file.identity.name,
    file.identity.description,
    file.identity.type,
    ...file.identity.aliases,
  ];
}

function buildArtifactIdentity(input: {
  path: string;
  originalName?: string;
  kind: string;
  source: GitMemoryTaskStateFileRecord["source"];
  title: string;
  objective: string;
}): GitMemoryTaskStateFileRecord["identity"] {
  const fileName = input.originalName?.trim() || basename(input.path);
  const subject = taskSubject(input.title, input.objective);
  const type = inferArtifactIdentityType(input.path, input.kind);
  const label = artifactLabel(fileName, type, input.source);
  const name = titleCase(`${subject} ${label}`.trim());
  const aliases = unique([
    fileName,
    stripExtension(fileName),
    label,
    `${subject} ${label}`,
    type.replace(/_/g, " "),
    ...(input.source === "user_attachment" ? [`uploaded ${label}`, `attached ${label}`] : []),
  ].flatMap((value) => [value, normalizeAlias(value)]));
  return {
    name,
    type,
    description: input.source === "user_attachment"
      ? `User-provided ${label} for ${subject}.`
      : `${label} for ${subject}.`,
    aliases,
  };
}

function taskSubject(title: string, objective: string): string {
  const source = title.trim() || objective.trim() || "task";
  return normalizeWords(source
    .replace(/^(create|build|make|update|fix|implement|add|write|generate)\s+/i, "")
    .replace(/\b(static|tiny|simple|new)\b/gi, " "))
    || "task";
}

function artifactLabel(fileName: string, type: string, source: GitMemoryTaskStateFileRecord["source"]): string {
  const stem = stripExtension(fileName).toLowerCase();
  if (stem === "index" && type === "html_page") return "homepage";
  if (["style", "styles", "main"].includes(stem) && type === "stylesheet") return "stylesheet";
  if (stem.includes("logo")) return "logo";
  if (type === "html_page") return `${normalizeWords(stem)} page`;
  if (type === "stylesheet") return "stylesheet";
  if (type === "script") return "script";
  if (type === "image_asset") return source === "user_attachment" ? "image asset" : "image";
  if (type === "directory") return `${normalizeWords(stem)} directory`;
  return normalizeWords(stem) || "artifact";
}

function inferArtifactKind(path: string): string {
  return extname(path) ? "file" : "directory";
}

function inferArtifactIdentityType(path: string, kind: string): string {
  if (kind === "directory") return "directory";
  const ext = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(ext)) return "html_page";
  if (ext === ".css") return "stylesheet";
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) return "script";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image_asset";
  if ([".json", ".csv", ".xlsx", ".xls", ".sqlite", ".db"].includes(ext)) return "data_file";
  if ([".md", ".txt", ".pdf", ".doc", ".docx"].includes(ext)) return "document";
  return "file";
}

function isUserAttachmentAsset(asset: TaskAssetRecord): boolean {
  return asset.role === "input" || asset.role === "reference" || Boolean(asset.sessionAssetId);
}

function stableArtifactId(source: GitMemoryTaskStateFileRecord["source"], path: string): string {
  return `artifact-${createHash("sha256").update(`${source}:${path}`).digest("hex").slice(0, 16)}`;
}

function stripExtension(value: string): string {
  const extension = extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function titleCase(value: string): string {
  return normalizeWords(value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function normalizeWords(value: string): string {
  return value
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAlias(value: string): string {
  return normalizeWords(value);
}

function deriveTaskStateSearchTerms(input: {
  taskId: GitMemoryTaskId;
  branch: string;
  title: string;
  objective: string;
  summary: string;
  completed: string[];
  open: string[];
  blockers: string[];
  facts: string[];
  next: string;
  files: string[];
  decisions: string[];
}): string[] {
  return unique([
    input.taskId,
    input.branch,
    input.title,
    input.objective,
    input.summary,
    input.next,
    ...input.completed,
    ...input.open,
    ...input.blockers,
    ...input.facts,
    ...input.files,
    ...input.decisions,
  ].flatMap(tokenizeSearchText));
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

async function readTaskRunStagedSteps(
  driver: GitMemoryWorktreeGitDriver,
  taskId: GitMemoryTaskId,
  runId: GitMemoryRunId,
): Promise<GitMemoryStepRecord[]> {
  return parseJsonl<GitMemoryStepRecord>(
    await driver.readWorkingFile(gitMemoryTaskStepsStagingPath(taskId, runId)),
  ).filter((record) => record.taskId === taskId && record.runId === runId);
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

    const [state, notesMarkdown] = await Promise.all([
      parseJson<GitMemoryTaskStateFile>(
        await driver.readFile(ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      ),
      driver.readFile(ref, gitMemoryTaskNotesPath(taskEntry.taskId)),
    ]);
    const notes = parseTaskNotesSearchFields(notesMarkdown ?? "");
    documents.push({
      entry: taskEntry,
      task: {
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
        title: state?.task.title ?? taskEntry.title,
        objective: state?.task.objective ?? taskEntry.title,
        status: state?.status ?? taskEntry.status,
        summary: state?.summary ?? taskEntry.title,
        open: state?.progress.open ?? [],
        blockers: state?.progress.blockers ?? [],
        facts: state?.memory.facts.map((fact) => fact.text) ?? [],
        next: state?.progress.next ?? taskEntry.title,
        updatedAt: state?.updatedAt ?? taskEntry.updatedAt,
        ...(state?.runs.latestRunId ? { latestRunId: state.runs.latestRunId } : notes.latestRunId ? { latestRunId: notes.latestRunId } : {}),
        ...(state?.context.importantFiles.length ? { files: state.context.importantFiles } : notes.files.length > 0 ? { files: notes.files } : {}),
        ...(state?.memory.files.length ? { artifacts: state.memory.files.map(taskSearchArtifactFromStateFile) } : {}),
        ...(!state ? { missing: true } : {}),
      },
      notesMarkdown: notesMarkdown ?? "",
      recentWork: notes.recentWork,
      searchTerms: state?.context.searchTerms ?? notes.searchTerms,
    });
  }

  return documents;
}

function taskSearchArtifactFromStateFile(record: GitMemoryTaskStateFileRecord): GitMemoryTaskSearchArtifact {
  return {
    artifactId: record.artifactId,
    source: record.source,
    kind: record.kind,
    path: record.path,
    ...(record.originalName ? { originalName: record.originalName } : {}),
    role: record.role,
    status: record.status,
    identity: record.identity,
    confidence: record.confidence,
  };
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
  for (const ref of await driver.listRefs("refs/ayati/sessions")) {
    const match = /\/reserved-runs\/(R-\d{8}-\d{4})$/.exec(ref);
    const sequence = match?.[1] ? runSequenceFromRunId(match[1]) : 0;
    if (sequence > 0) {
      sequences.push(sequence);
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
  const stepPrefix = `${gitMemoryTaskDir(taskId)}/steps`;
  const stepPaths = (await driver.listTreePaths(ref, stepPrefix))
    .filter((path) => path.endsWith(".jsonl"))
    .sort();
  const stepRecords: GitMemoryEvidenceManifestRecord[] = [];
  for (const path of stepPaths) {
    stepRecords.push(...await readRefJsonl<GitMemoryStepRecord>(driver, ref, path).then((steps) => steps.map(stepToEvidenceRecord)));
  }
  if (stepRecords.length > 0) {
    return stepRecords;
  }

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
  const steps = await readRefJsonl<GitMemoryStepRecord>(driver, ref, gitMemoryTaskStepsPath(taskId, runId));
  if (steps.length > 0) {
    return tail(steps.map(stepToEvidenceRecord), limit);
  }
  const path = legacyGitMemoryTaskEvidenceManifestPath(taskId, runId);
  const raw = await driver.readFile(ref, path);
  if (raw === null) {
    throw new Error(`Git memory step log or evidence manifest not found for run: ${runId}`);
  }
  return tail(parseJsonl<GitMemoryEvidenceManifestRecord>(raw), limit);
}

function legacyGitMemoryTaskEvidenceManifestPath(taskId: GitMemoryTaskId, runId: GitMemoryRunId): string {
  return `${gitMemoryTaskDir(taskId)}/evidence/${runId}/manifest.jsonl`;
}

function findRunStepRecord(
  records: GitMemoryStepRecord[],
  input: Pick<ReadGitMemoryRunStepInput, "runId" | "step" | "callId">,
): { record: GitMemoryStepRecord; toolCall?: GitMemoryStepToolCallRecord } | undefined {
  const record = records.find((candidate) => candidate.runId === input.runId && candidate.step === input.step);
  if (!record) {
    return undefined;
  }
  if (!input.callId) {
    return { record };
  }
  const toolCall = record.toolCalls.find((call) => call.callId === input.callId);
  return toolCall ? { record, toolCall } : undefined;
}

function buildRunStepReadResult(input: {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  source: GitMemoryRunStepReadResult["source"];
  record: GitMemoryStepRecord;
  toolCall?: GitMemoryStepToolCallRecord;
}): GitMemoryRunStepReadResult {
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    branch: input.branch,
    ref: input.ref,
    runId: input.record.runId,
    step: input.record.step,
    source: input.source,
    record: input.record,
    ...(input.toolCall ? { toolCall: input.toolCall } : {}),
  };
}

function stepToEvidenceRecord(step: GitMemoryStepRecord): GitMemoryEvidenceManifestRecord {
  const tools = step.toolCalls.map((call) => call.tool).filter(Boolean);
  return {
    v: 1,
    runId: step.runId,
    taskId: step.taskId,
    step: step.step,
    tool: tools.length > 0 ? unique(tools).join(",") : "agent_step",
    status: step.status === "failed" ? "failed" : step.status === "skipped" ? "skipped" : "completed",
    summary: step.summary || step.verification.summary || step.verification.evidenceSummary || "Step completed.",
    evidenceRef: step.verification.evidenceSummary ?? step.summary,
    artifacts: step.artifacts,
    facts: step.facts,
    accessModes: ["step"],
    ...(step.outputSize !== undefined ? { outputSize: step.outputSize } : {}),
    ...(step.lineCount !== undefined ? { lineCount: step.lineCount } : {}),
    ...(step.truncated !== undefined ? { truncated: step.truncated } : {}),
    source: {
      kind: "git-memory-step",
      step: step.step,
    },
  };
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
  const scored = scoreGitMemoryTaskSearchDocument(document, rawQuery, queryTokens);
  return {
    ...document.task,
    score: scored.score,
    routeScore: scored.routeScore,
    matchReasons: scored.matchReasons,
    ...(scored.matchedArtifacts.length > 0 ? { matchedArtifacts: scored.matchedArtifacts } : {}),
  };
}

export interface GitMemoryTaskSearchScore {
  score: number;
  routeScore: number;
  matchReasons: string[];
  matchedArtifacts: GitMemoryTaskSearchArtifact[];
}

export function scoreGitMemoryTaskSearchDocument(
  document: {
    task: GitMemoryTaskRoutingSnapshotTask;
    notesMarkdown?: string;
    recentWork?: string[];
    searchTerms?: string[];
  },
  rawQuery: string,
  queryTokens = tokenizeSearchText(rawQuery),
): GitMemoryTaskSearchScore {
  const task = document.task;
  const reasons = new Set<string>();
  const matchedArtifacts = new Map<string, GitMemoryTaskSearchArtifact>();
  let score = 0;
  let routeScore = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);

  const weightedFields: Array<{
    reason: string;
    searchWeight: number;
    routeSingleTokenScore: number;
    routeMultiTokenScore: number;
    values: string[];
  }> = [
    { reason: "taskId", searchWeight: 100, routeSingleTokenScore: 100, routeMultiTokenScore: 100, values: [task.taskId] },
    { reason: "branch", searchWeight: 60, routeSingleTokenScore: 45, routeMultiTokenScore: 85, values: [task.branch] },
    { reason: "title", searchWeight: 55, routeSingleTokenScore: 55, routeMultiTokenScore: 90, values: [task.title] },
    { reason: "objective", searchWeight: 45, routeSingleTokenScore: 40, routeMultiTokenScore: 75, values: [task.objective] },
    { reason: "files", searchWeight: 58, routeSingleTokenScore: 58, routeMultiTokenScore: 78, values: task.files ?? [] },
    { reason: "summary", searchWeight: 30, routeSingleTokenScore: 30, routeMultiTokenScore: 60, values: [task.summary] },
    { reason: "next", searchWeight: 28, routeSingleTokenScore: 28, routeMultiTokenScore: 58, values: [task.next] },
    { reason: "facts", searchWeight: 26, routeSingleTokenScore: 26, routeMultiTokenScore: 62, values: task.facts },
    { reason: "recentWork", searchWeight: 24, routeSingleTokenScore: 24, routeMultiTokenScore: 55, values: document.recentWork ?? [] },
    { reason: "searchTerms", searchWeight: 22, routeSingleTokenScore: 22, routeMultiTokenScore: 55, values: document.searchTerms ?? [] },
    { reason: "open", searchWeight: 20, routeSingleTokenScore: 20, routeMultiTokenScore: 72, values: task.open },
    { reason: "blockers", searchWeight: 18, routeSingleTokenScore: 18, routeMultiTokenScore: 50, values: task.blockers },
    { reason: "status", searchWeight: 5, routeSingleTokenScore: 5, routeMultiTokenScore: 5, values: [task.status] },
    { reason: "notes", searchWeight: 4, routeSingleTokenScore: 4, routeMultiTokenScore: 20, values: [document.notesMarkdown ?? ""] },
  ];

  for (const field of weightedFields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += queryTokens.length > 1 ? field.searchWeight * 3 : field.searchWeight;
      routeScore = Math.max(routeScore, queryTokens.length > 1
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.searchWeight;
      routeScore = Math.max(routeScore, hits >= 2
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
    }
  }

  for (const artifact of task.artifacts ?? []) {
    const artifactScore = scoreTaskSearchArtifact(artifact, normalizedQuery, queryTokens);
    if (artifactScore.score <= 0) {
      continue;
    }
    score += artifactScore.score;
    routeScore = Math.max(routeScore, artifactScore.routeScore);
    matchedArtifacts.set(artifact.artifactId, artifact);
    for (const reason of artifactScore.reasons) {
      reasons.add(reason);
    }
  }

  return {
    score,
    routeScore,
    matchReasons: [...reasons],
    matchedArtifacts: [...matchedArtifacts.values()],
  };
}

function scoreTaskSearchArtifact(
  artifact: GitMemoryTaskSearchArtifact,
  normalizedQuery: string,
  queryTokens: string[],
): { score: number; routeScore: number; reasons: string[] } {
  let score = 0;
  let routeScore = 0;
  const reasons = new Set<string>();
  const fields: Array<{
    reason: string;
    searchWeight: number;
    routeSingleTokenScore: number;
    routeMultiTokenScore: number;
    values: string[];
  }> = [
    { reason: "artifactPath", searchWeight: 95, routeSingleTokenScore: 82, routeMultiTokenScore: 95, values: [artifact.path] },
    { reason: "artifactFilename", searchWeight: 86, routeSingleTokenScore: 78, routeMultiTokenScore: 88, values: [basename(artifact.path)] },
    { reason: "artifactOriginalName", searchWeight: 90, routeSingleTokenScore: 82, routeMultiTokenScore: 90, values: artifact.originalName ? [artifact.originalName] : [] },
    { reason: "artifactIdentity", searchWeight: 88, routeSingleTokenScore: 70, routeMultiTokenScore: 88, values: [artifact.identity.name] },
    { reason: "artifactAlias", searchWeight: 82, routeSingleTokenScore: 68, routeMultiTokenScore: 82, values: artifact.identity.aliases },
    { reason: "artifactType", searchWeight: 20, routeSingleTokenScore: 20, routeMultiTokenScore: 40, values: [artifact.identity.type, artifact.kind, artifact.role] },
    { reason: "artifactSource", searchWeight: 15, routeSingleTokenScore: 15, routeMultiTokenScore: 35, values: [artifact.source] },
  ];

  for (const field of fields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += queryTokens.length > 1 ? field.searchWeight * 3 : field.searchWeight;
      routeScore = Math.max(routeScore, queryTokens.length > 1
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.searchWeight;
      routeScore = Math.max(routeScore, hits >= 2
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
    }
  }

  const hasSpecificAttachmentWord = queryTokens.some((token) => token === "uploaded" || token === "attachment" || token === "attached");
  const hasUploadWord = queryTokens.includes("upload");
  if (artifact.source === "user_attachment" && (hasSpecificAttachmentWord || hasUploadWord)) {
    const identityText = normalizeSearchText([
      artifact.originalName,
      artifact.path,
      artifact.identity.name,
      ...artifact.identity.aliases,
    ].filter(Boolean).join(" "));
    const semanticHits = queryTokens.filter((token) => identityText.includes(token)).length;
    if (semanticHits > 0 && (hasSpecificAttachmentWord || semanticHits >= 2)) {
      score += 90 + semanticHits * 30;
      routeScore = Math.max(routeScore, semanticHits >= 2 ? 95 : 85);
      reasons.add("userAttachment");
    }
  }

  return {
    score,
    routeScore,
    reasons: [...reasons],
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

function buildStepRecordsFromLegacyEvidence(input: {
  taskId: GitMemoryTaskId;
  runId: GitMemoryRunId;
  actions: GitMemoryActionRecord[];
  evidence: GitMemoryEvidenceManifestRecord[];
  completedAt: string;
}): GitMemoryStepRecord[] {
  const evidence = input.evidence.length > 0
    ? input.evidence
    : input.actions.map((action, index): GitMemoryEvidenceManifestRecord => ({
      v: 1,
      runId: input.runId,
      taskId: input.taskId,
      step: index + 1,
      actionId: action.actionId,
      tool: action.tool,
      status: action.status,
      summary: action.summary,
      ...(action.evidenceRef ? { evidenceRef: action.evidenceRef } : {}),
      artifacts: [],
      facts: [],
      accessModes: action.evidenceRef ? ["summary"] : [],
      source: { kind: "legacy-action" },
    }));
  return evidence.map((record, index): GitMemoryStepRecord => {
    const status = record.status === "failed"
      ? "failed"
      : record.status === "skipped"
        ? "skipped"
        : "completed";
    return {
      v: 1,
      runId: input.runId,
      taskId: input.taskId,
      step: record.step ?? index + 1,
      status,
      completedAt: input.completedAt,
      summary: record.summary,
      action: {
        toolsUsed: [record.tool],
        toolSuccessCount: status === "completed" ? 1 : 0,
        toolFailureCount: status === "failed" ? 1 : 0,
      },
      toolCalls: [{
        tool: record.tool,
        status: status === "failed" ? "failed" : "success",
        input: {},
        ...(record.evidenceRef ? { output: record.evidenceRef } : {}),
      }],
      verification: {
        passed: status === "completed",
        policy: "deterministic",
        summary: record.summary,
        ...(record.evidenceRef ? { evidenceSummary: record.evidenceRef } : {}),
        evidenceItems: record.facts,
        newFacts: record.facts,
        artifacts: record.artifacts,
        usedRawArtifacts: [],
      },
      facts: record.facts,
      artifacts: record.artifacts,
      ...(record.outputSize !== undefined ? { outputSize: record.outputSize } : {}),
      ...(record.lineCount !== undefined ? { lineCount: record.lineCount } : {}),
      ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
    };
  });
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
