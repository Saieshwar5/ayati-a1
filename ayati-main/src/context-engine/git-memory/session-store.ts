import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskAssetRecord } from "../contracts.js";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { parseGitMemoryCommitTrailers, renderGitMemoryCommitMessage, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
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
  resolveGitMemoryTaskEntry,
} from "./task-refs.js";
import { renderGitMemoryTaskNotes } from "./task-notes.js";
import {
  renderGitMemorySessionSummaryMarkdown,
  renderGitMemorySessionSummaryMetadata,
} from "./session-summary.js";
import {
  defaultRunOutcome,
  defaultSessionRunOutcome,
  formatConversationRefs,
  jsonl,
  prettyJson,
  renderSessionRunMarkdown,
  renderTaskRunMarkdown,
} from "./session-store-renderers.js";
import {
  buildInitialSessionStoreFiles,
  pathExists,
  runIdFromRunPath,
  type BuildInitialSessionFilesInput,
} from "./session-store-paths.js";
import {
  activeTaskFromCustomRef,
  normalizeReadLimit,
  normalizeTaskDetailInclude,
  normalizeTaskDetailLimits,
  readAllTaskEvidence,
  readCompactLog,
  readRecentTaskActions,
  readRecentTaskEvidence,
  readRecentTaskRunMarkdown,
  readRecentTaskRuns,
  readTaskConversationMarkdownTail,
  readTaskEvidenceForRun,
  readTaskRoutingSnapshotFromDriver,
  readTaskSearchDocumentsFromDriver,
  scoreEvidenceSearchMatch,
  scoreTaskSearchMatch,
  tokenizeSearchText,
} from "./session-store-readers.js";
import {
  compareSessionAttachments,
  GIT_MEMORY_MAIN_REF,
  isGitMemorySessionAttachmentRecord,
  normalizeSessionAttachmentsFile,
  openExistingSessionMessageStoreDriver,
  readSessionConversation,
  readSessionMessageStoreAttachments,
  readSessionMessageStoreConversation,
  readSessionMeta,
  readWorkingConversation,
  writeSessionMessageStoreAttachments,
  writeSessionMessageStoreWorkingRecord,
} from "./session-message-store.js";
import {
  actionSummaries,
  actionVerificationSummaries,
  deriveTaskStateSearchTerms,
  evidenceSummaries,
  isTaskAssetRecord,
  mergeTaskAssets,
  mergeTaskStateDecisions,
  mergeTaskStateEvidence,
  mergeTaskStateFacts,
  mergeTaskStateFiles,
  normalizeMemoryList,
  sameTaskAssets,
  taskNoteFiles,
  taskStateDecisions,
  taskStateEvidence,
  taskStateFacts,
  taskStateFiles,
  taskStateFilesFromAssets,
  taskStateFileSearchTerms,
} from "./task-state-reducer.js";
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
  GitMemorySessionRunFile,
  GitMemorySessionRunPromotion,
  GitMemorySessionRunStatus,
  GitMemorySessionSummaryMetaFile,
  GitMemorySessionStepRecord,
  GitMemoryTaskId,
  GitMemoryTaskAssetsFile,
  GitMemoryTaskStateFile,
  GitMemoryTaskStateFileRecord,
  GitMemoryTaskStatus,
  GitMemoryStepRecord,
  GitMemoryStepToolCallRecord,
} from "./schema.js";
import {
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
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStepsPath,
  gitMemoryTaskStepsStagingPath,
  gitMemoryTaskStatePath,
  gitMemorySessionStoreActiveRunPath,
  gitMemorySessionStoreActiveRunStepsPath,
  gitMemorySessionStoreSessionDir,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  gitMemorySessionStoreRunMarkdownPath,
  gitMemorySessionStoreRunPath,
  gitMemorySessionStoreRunsDir,
  gitMemorySessionStoreStepsPath,
  isGitMemoryRunId,
  isGitMemorySessionId,
} from "./schema.js";

export { GIT_MEMORY_MAIN_REF } from "./session-message-store.js";
export { scoreGitMemoryTaskSearchDocument } from "./session-store-readers.js";
export type { GitMemoryTaskSearchScore } from "./session-store-readers.js";

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

export interface StartGitMemorySessionRunInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  at?: string;
  triggerSeq?: number;
}

export interface StartGitMemorySessionRunResult {
  runId: GitMemoryRunId;
}

export interface RecordGitMemorySessionRunStepInput {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  record: GitMemorySessionStepRecord;
}

export interface FinalizeGitMemorySessionRunInput {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  status: Exclude<GitMemorySessionRunStatus, "running" | "promoted">;
  startedAt?: string;
  completedAt?: string;
  triggerSeq?: number;
  conversationRefs: GitMemoryConversationSeqRange[];
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed?: string[];
  verification?: string[];
  decisions?: string[];
  assistantResponse?: string;
  toolCallCount?: number;
  toolsUsed?: string[];
  changedFiles?: string[];
  newFacts?: string[];
  workState?: unknown;
  blockers?: string[];
  next?: string;
}

export interface FinalizeGitMemorySessionRunResult {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  committed: false;
  sessionStoreCommit?: undefined;
}

export interface PromoteGitMemorySessionRunInput {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
}

export interface PromoteGitMemorySessionRunResult {
  sessionId: GitMemorySessionId;
  runId: GitMemoryRunId;
  promotedTo: GitMemorySessionRunPromotion;
  promotedStepCount: number;
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
  allowActiveSessionRun?: boolean;
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
    return createGitMemoryRunId(date, await nextRunSequence(driver, sessionId));
  }

  async startSessionRun(input: StartGitMemorySessionRunInput): Promise<StartGitMemorySessionRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    if (await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId))) {
      throw new Error(`Git memory session run already active: ${input.runId}`);
    }
    if (await messageStore.readFile(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreRunPath(input.sessionId, input.runId))) {
      throw new Error(`Git memory session run already finalized: ${input.runId}`);
    }
    if (await readGitMemoryCustomRef(driver, gitMemorySessionRunReservationRef(input.sessionId, input.runId))) {
      throw new Error(`Git memory task run already reserved: ${input.runId}`);
    }
    const startedAt = input.at ?? this.nowIso();
    const run: GitMemorySessionRunFile = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      runId: input.runId,
      runClass: "session",
      status: "running",
      startedAt,
      triggerSeq: input.triggerSeq ?? input.fromSeq,
      conversationRefs: [{ fromSeq: input.fromSeq, toSeq: input.toSeq }],
      summary: "Session run is active.",
      toolCallCount: 0,
      toolsUsed: [],
      changedFiles: [],
      newFacts: [],
    };
    await messageStore.writeWorkingFiles({
      [gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId)]: prettyJson(run),
      [gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId)]: "",
    });
    return { runId: input.runId };
  }

  async appendSessionRunStep(input: RecordGitMemorySessionRunStepInput): Promise<void> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    if (!await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId))) {
      throw new Error(`Git memory session run is not active: ${input.runId}`);
    }
    if (input.record.sessionId !== input.sessionId || input.record.runId !== input.runId) {
      throw new Error(`Git memory session step record does not match session/run: ${input.sessionId}/${input.runId}`);
    }
    await messageStore.appendWorkingFile(
      gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId),
      `${JSON.stringify(input.record)}\n`,
    );
  }

  async finalizeSessionRun(input: FinalizeGitMemorySessionRunInput): Promise<FinalizeGitMemorySessionRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const activeRun = parseJson<GitMemorySessionRunFile>(
      await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId)),
    );
    if (!activeRun) {
      throw new Error(`Git memory session run is not active: ${input.runId}`);
    }
    if (await messageStore.readFile(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreRunPath(input.sessionId, input.runId))) {
      throw new Error(`Git memory session run already finalized: ${input.runId}`);
    }
    const steps = readSessionRunWorkingSteps(
      await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId)),
    ).filter((record) => record.sessionId === input.sessionId && record.runId === input.runId);
    const completedAt = input.completedAt ?? this.nowIso();
    const workPerformed = normalizeMemoryList(input.workPerformed)
      ?? normalizeMemoryList(steps.map((step) => step.summary))
      ?? [];
    const verification = normalizeMemoryList(input.verification)
      ?? normalizeMemoryList(steps.flatMap((step) => [
        step.verification.evidenceSummary,
        ...step.verification.evidenceItems,
      ]))
      ?? [];
    const decisions = normalizeMemoryList(input.decisions) ?? [];
    const blockers = normalizeMemoryList(input.blockers) ?? [];
    const next = input.next?.trim();
    const changedFiles = normalizeStrings(input.changedFiles ?? []);
    const newFacts = normalizeStrings(input.newFacts ?? steps.flatMap((step) => step.facts));
    const workState = input.workState ?? latestSessionRunWorkState(steps);
    const run: GitMemorySessionRunFile = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      runId: input.runId,
      runClass: "session",
      status: input.status,
      startedAt: input.startedAt ?? activeRun.startedAt,
      completedAt,
      triggerSeq: input.triggerSeq ?? activeRun.triggerSeq,
      conversationRefs: input.conversationRefs,
      summary: input.summary,
      intent: input.intent ?? input.summary,
      routing: input.routing ?? formatConversationRefs(input.conversationRefs),
      outcome: input.outcome ?? defaultSessionRunOutcome(input.status, input.summary),
      ...(workPerformed.length > 0 ? { workPerformed } : {}),
      ...(verification.length > 0 ? { verification } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(input.assistantResponse?.trim() ? { assistantResponse: input.assistantResponse } : {}),
      toolCallCount: input.toolCallCount ?? countSessionRunToolCalls(steps),
      toolsUsed: normalizeStrings(input.toolsUsed ?? steps.flatMap((step) => step.toolCalls.map((call) => call.tool))),
      changedFiles,
      newFacts,
      ...(workState !== undefined ? { workState } : {}),
      ...(blockers.length > 0 ? { blockers } : {}),
      ...(next ? { next } : {}),
    };
    const runPath = gitMemorySessionStoreRunPath(input.sessionId, input.runId);
    const markdownPath = gitMemorySessionStoreRunMarkdownPath(input.sessionId, input.runId);
    const stepsPath = gitMemorySessionStoreStepsPath(input.sessionId, input.runId);
    await messageStore.writeWorkingFiles({
      [runPath]: prettyJson(run),
      [markdownPath]: renderSessionRunMarkdown(run, steps),
      [stepsPath]: jsonl(steps),
    });
    await messageStore.removeWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId));
    await messageStore.removeWorkingFile(gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId));
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      committed: false,
    };
  }

  async promoteSessionRunToTaskRun(input: PromoteGitMemorySessionRunInput): Promise<PromoteGitMemorySessionRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const activeRun = await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId));
    if (!activeRun) {
      throw new Error(`Git memory session run is not active: ${input.runId}`);
    }
    if (await messageStore.readFile(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreRunPath(input.sessionId, input.runId))) {
      throw new Error(`Git memory session run already finalized: ${input.runId}`);
    }
    const taskEntry = await resolveGitMemoryTaskEntry(driver, { taskId: input.taskId });
    if (taskEntry.branch !== input.branch) {
      throw new Error(`Git memory task branch mismatch for promotion: ${input.taskId}`);
    }
    const taskRef = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(taskRef))) {
      throw new Error(`Git memory task branch missing: ${taskRef}`);
    }
    const sessionSteps = readSessionRunWorkingSteps(
      await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId)),
    ).filter((record) => record.sessionId === input.sessionId && record.runId === input.runId);
    const taskSteps = sessionSteps.map(({ sessionId: _sessionId, ...record }): GitMemoryStepRecord => ({
      ...record,
      taskId: input.taskId,
    }));
    for (const step of taskSteps) {
      await driver.appendWorkingFile(
        gitMemoryTaskStepsStagingPath(input.taskId, input.runId),
        `${JSON.stringify(step)}\n`,
      );
    }
    await messageStore.removeWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId));
    await messageStore.removeWorkingFile(gitMemorySessionStoreActiveRunStepsPath(input.sessionId, input.runId));
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      promotedTo: {
        taskId: input.taskId,
        branch: input.branch,
        ref: input.ref,
      },
      promotedStepCount: taskSteps.length,
    };
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
    if (!input.allowActiveSessionRun) {
      const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      if (await messageStore.readWorkingFile(gitMemorySessionStoreActiveRunPath(input.sessionId, input.runId))) {
        throw new Error(`Git memory session run already active: ${input.runId}`);
      }
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

    const runId = input.runId ?? createGitMemoryRunId(date, await nextRunSequence(driver, input.sessionId));
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

function readSessionRunWorkingSteps(value: string | null): GitMemorySessionStepRecord[] {
  return parseJsonl<GitMemorySessionStepRecord>(value)
    .filter((record) => (
      record
      && typeof record === "object"
      && record.v === 1
      && isGitMemorySessionId(record.sessionId)
      && isGitMemoryRunId(record.runId)
      && Number.isInteger(record.step)
    ));
}

function countSessionRunToolCalls(steps: GitMemorySessionStepRecord[]): number {
  return steps.reduce((sum, step) => sum + step.toolCalls.length, 0);
}

function latestSessionRunWorkState(steps: GitMemorySessionStepRecord[]): unknown {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.workStateAfter !== undefined) {
      return steps[index]?.workStateAfter;
    }
  }
  return undefined;
}

function normalizeStrings(values: string[] | undefined): string[] {
  return unique((values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0));
}

async function nextRunSequence(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<number> {
  const sequences = [
    ...await runSequencesFromTasks(driver),
    ...await runSequencesFromSessionStore(driver, sessionId),
  ];
  return Math.max(0, ...sequences) + 1;
}

async function runSequencesFromTasks(driver: GitMemoryWorktreeGitDriver): Promise<number[]> {
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
  return sequences;
}

async function runSequencesFromSessionStore(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<number[]> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return [];
  }
  const sequences: number[] = [];
  const finalPrefix = gitMemorySessionStoreRunsDir(sessionId);
  const finalPaths = (await messageStore.listTreePaths(GIT_MEMORY_MAIN_REF, finalPrefix))
    .filter((path) => path.endsWith(".json"));
  for (const path of finalPaths) {
    const sequence = runSequenceFromRunId(runIdFromRunPath(path));
    if (sequence > 0) {
      sequences.push(sequence);
    }
  }
  const activeRunsDir = join(messageStore.repoPath, gitMemorySessionStoreSessionDir(sessionId), "active-runs");
  const entries = await readdir(activeRunsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isGitMemoryRunId(entry.name)) {
      continue;
    }
    const sequence = runSequenceFromRunId(entry.name);
    if (sequence > 0) {
      sequences.push(sequence);
    }
  }
  return sequences;
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

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nextSeq(records: Array<{ seq?: unknown }>): number {
  return records.reduce((max, record) => (
    typeof record.seq === "number" && Number.isInteger(record.seq) ? Math.max(max, record.seq) : max
  ), 0) + 1;
}

function runSequenceFromRunId(runId: GitMemoryRunId): number {
  const sequence = Number(runId.split("-")[2] ?? "0");
  return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
}

function actionSequenceForRun(runId: GitMemoryRunId, actionIndex: number): number {
  const runSequence = runSequenceFromRunId(runId);
  return runSequence * 100 + actionIndex + 1;
}
