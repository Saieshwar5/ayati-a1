import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { parseGitMemoryCommitTrailers, renderGitMemoryCommitMessage, type ParsedGitMemoryCommitTrailers } from "./commit-message.js";
import type {
  GitMemoryActionId,
  GitMemoryActionRecord,
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryConversationSeqRange,
  GitMemoryEvidenceManifestRecord,
  GitMemoryFocusFile,
  GitMemoryRunId,
  GitMemoryRunFile,
  GitMemoryRunStatus,
  GitMemorySessionEventRecord,
  GitMemorySessionId,
  GitMemorySessionMetaFile,
  GitMemoryTaskId,
  GitMemoryTaskFile,
  GitMemoryTaskIndexFile,
  GitMemoryTaskStateFile,
  GitMemoryTaskLinkReason,
  GitMemoryTaskMessageLinkRecord,
  GitMemoryTaskStatus,
  GitMemoryTurnId,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
  buildGitMemoryTaskBranchName,
  buildGitMemoryTaskBranchRef,
  createGitMemoryActionId,
  createGitMemoryEventId,
  createGitMemoryLinkId,
  createGitMemoryMessageId,
  createGitMemoryRunId,
  createGitMemorySessionId,
  createGitMemoryTaskId,
  createGitMemoryTurnId,
  gitMemoryDateFromSessionId,
  gitMemoryTaskDir,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskActionsPath,
  gitMemoryTaskContextPath,
  gitMemoryTaskEvidenceManifestPath,
  gitMemoryTaskFilePath,
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStatePath,
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
  conversationSegmentLimit: number;
  conversationMarkdownCharLimit: number;
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
  task?: GitMemoryTaskFile;
  state?: GitMemoryTaskStateFile;
  assets?: unknown[];
  recentRuns?: GitMemoryRunFile[];
  recentActions?: GitMemoryTaskActionGroup[];
  recentCommits?: CompactGitMemoryStoreCommitSummary[];
  recentEvidence?: GitMemoryEvidenceManifestRecord[];
  conversation?: GitMemoryTaskConversationSegment[];
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
  event: GitMemorySessionEventRecord;
  commit: string;
}

export interface AppendGitMemoryConversationInput {
  sessionId: GitMemorySessionId;
  role: GitMemoryConversationRole;
  text: string;
  at?: string;
  turnId?: GitMemoryTurnId;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface LinkGitMemoryTaskMessagesInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  branch: string;
  reason: GitMemoryTaskLinkReason;
  at?: string;
  turnIds?: GitMemoryTurnId[];
  runId?: GitMemoryRunId;
  summary?: string;
}

export interface GitMemoryTaskConversationSegment {
  link: GitMemoryTaskMessageLinkRecord;
  messages: GitMemoryConversationRecord[];
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
  missing?: boolean;
}

export interface GitMemoryTaskRoutingSnapshot {
  sessionId: GitMemorySessionId;
  focus: GitMemoryFocusFile | null;
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
  taskCommit: string;
  link: GitMemoryTaskMessageLinkRecord;
}

export interface SelectGitMemoryTaskForTurnInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  reason: Exclude<GitMemoryTaskLinkReason, "task_created" | "task_reference">;
  at?: string;
  turnIds?: GitMemoryTurnId[];
  runId?: GitMemoryRunId;
  summary?: string;
}

export interface SelectGitMemoryTaskForTurnResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  link: GitMemoryTaskMessageLinkRecord;
  focusEvent?: GitMemorySessionEventRecord;
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
  summary: string;
  assistantResponse?: string;
  actions?: CommitGitMemoryTaskRunActionInput[];
  toolCallCount?: number;
  changedFiles?: string[];
  newFacts?: string[];
  next?: string;
  state?: Partial<Omit<GitMemoryTaskStateFile, "schemaVersion" | "updatedAt">>;
  evidence?: CommitGitMemoryTaskRunEvidenceInput[];
}

export interface CommitGitMemoryTaskRunResult {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  runId: GitMemoryRunId;
  taskCommit: string;
  event: GitMemorySessionEventRecord;
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
  event: GitMemorySessionEventRecord;
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
      const [hasMainRef, metaRaw, tasksRaw, focusRaw] = await Promise.all([
        driver.hasRef(GIT_MEMORY_MAIN_REF),
        driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_META_PATH),
        driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
        driver.readWorkingFile(GIT_MEMORY_SESSION_FOCUS_PATH),
      ]);
      const meta = parseJson<GitMemorySessionMetaFile>(metaRaw);
      const tasks = parseJson<GitMemoryTaskIndexFile>(tasksRaw);
      const focus = parseJson<GitMemoryFocusFile>(focusRaw);

      sessions.push({
        sessionId: meta?.sessionId ?? entry,
        repoPath,
        ...(meta?.date ? { date: meta.date } : {}),
        ...(meta?.timezone ? { timezone: meta.timezone } : {}),
        ...(meta?.agentId ? { agentId: meta.agentId } : {}),
        ...(meta?.createdAt ? { createdAt: meta.createdAt } : {}),
        taskCount: tasks?.tasks.length ?? 0,
        ...(focus?.activeTaskId ? { activeTaskId: focus.activeTaskId } : {}),
        ...(focus?.activeBranch ? { activeBranch: focus.activeBranch } : {}),
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
      return { sessionId, repoPath, initialized: false };
    }

    const createdAt = input.createdAt ?? this.nowProvider().toISOString();
    const files = buildInitialSessionFiles({
      sessionId,
      date: input.date,
      timezone: input.timezone,
      agentId: input.agentId,
      createdAt,
    });
    const initialCommit = await driver.commitFiles({
      files,
      message: renderGitMemoryCommitMessage({
        subject: `ayati: initialize session ${sessionId}`,
        summary: "Create the daily git-memory session repo and base memory files.",
        trailers: {
          sessionId,
          event: "session_initialized",
          at: createdAt,
          schemaVersion: 1,
        },
      }),
    });

    return { sessionId, repoPath, initialized: true, initialCommit };
  }

  async appendConversationMessage(input: AppendGitMemoryConversationInput): Promise<GitMemoryConversationRecord> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const existing = parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    );
    const seq = nextSeq(existing);
    const record: GitMemoryConversationRecord = {
      v: 1,
      seq,
      messageId: createGitMemoryMessageId(date, seq),
      turnId: input.turnId ?? createGitMemoryTurnId(date, seq),
      role: input.role,
      at: input.at ?? this.nowIso(),
      text: input.text,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    const existingMarkdown = await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_CONVERSATION_PATH]: jsonl([...existing, record]),
      [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: appendConversationMarkdown(existingMarkdown, record),
    });
    return record;
  }

  async linkTaskMessages(input: LinkGitMemoryTaskMessagesInput): Promise<GitMemoryTaskMessageLinkRecord> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const existingLinks = parseJsonl<GitMemoryTaskMessageLinkRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH),
    );
    const conversation = parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    );
    const messages = conversationInRange(conversation, input);
    const link: GitMemoryTaskMessageLinkRecord = {
      v: 1,
      linkId: createGitMemoryLinkId(date, existingLinks.length + 1),
      taskId: input.taskId,
      branch: input.branch,
      reason: input.reason,
      at: input.at ?? this.nowIso(),
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      turnIds: input.turnIds ?? unique(messages.map((message) => message.turnId)),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
    };
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH]: jsonl([...existingLinks, link]),
    });
    return link;
  }

  async allocateTaskRunId(sessionId: GitMemorySessionId): Promise<GitMemoryRunId> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
    const date = gitMemoryDateFromSessionId(sessionId);
    const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
    );
    return createGitMemoryRunId(date, nextRunSequence(existingEvents));
  }

  async startTaskRun(input: StartGitMemoryTaskRunInput): Promise<StartGitMemoryTaskRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const ref = `refs/heads/${input.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }
    const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
    );
    const existing = existingEvents.find((event) => event.type === "run_started" && event.runId === input.runId);
    if (existing) {
      return { runId: input.runId, event: existing };
    }

    const eventSeq = nextSeq(existingEvents);
    const event: GitMemorySessionEventRecord = {
      v: 1,
      seq: eventSeq,
      eventId: createGitMemoryEventId(date, eventSeq),
      type: "run_started",
      at: input.at ?? this.nowIso(),
      taskId: input.taskId,
      runId: input.runId,
      branch: input.branch,
      conversationSeq: { fromSeq: input.fromSeq, toSeq: input.toSeq },
    };
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([...existingEvents, event]),
    });
    const conversation = parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    );
    const taskConversation = conversationInRange(conversation, input);
    const existingMarkdown = await driver.readFile(ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH);
    const nextMarkdown = appendConversationMarkdownRecords(existingMarkdown, taskConversation, {
      taskId: input.taskId,
      runId: input.runId,
    });
    if (nextMarkdown !== existingMarkdown) {
      await driver.commitSyntheticFiles({
        ref,
        files: {
          [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: nextMarkdown,
        },
        message: renderGitMemoryCommitMessage({
          subject: `ayati: start run ${input.runId}`,
          summary: `Record task conversation for run ${input.runId}.`,
          trailers: {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            event: "run_started",
            at: event.at,
            branch: input.branch,
            conversationSeq: { fromSeq: input.fromSeq, toSeq: input.toSeq },
            schemaVersion: 1,
          },
        }),
      });
    }
    return { runId: input.runId, event };
  }

  async readTaskConversationSegments(
    sessionId: GitMemorySessionId,
    taskId: GitMemoryTaskId,
  ): Promise<GitMemoryTaskConversationSegment[]> {
    const driver = await this.openExistingDriver(sessionId);
    const conversation = parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    );
    const links = parseJsonl<GitMemoryTaskMessageLinkRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH),
    );
    return links
      .filter((link) => link.taskId === taskId)
      .map((link) => ({
        link,
        messages: conversationInRange(conversation, link),
      }));
  }

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    const driver = await this.openExistingDriver(sessionId);
    return await readTaskRoutingSnapshotFromDriver(driver, sessionId);
  }

  async readTaskDetail(input: ReadGitMemoryTaskDetailInput): Promise<GitMemoryTaskDetail> {
    const driver = await this.openExistingDriver(input.sessionId);
    const taskEntry = await resolveTaskEntry(driver, input);
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

    const readTask = include.has("task")
      ? readRefJson<GitMemoryTaskFile>(driver, ref, gitMemoryTaskFilePath(taskEntry.taskId))
      : Promise.resolve(null);
    const readState = include.has("state")
      ? readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskEntry.taskId))
      : Promise.resolve(null);
    const readAssets = include.has("assets")
      ? readRefJsonl<unknown>(driver, ref, gitMemoryTaskAssetsPath(taskEntry.taskId))
      : Promise.resolve([]);
    const readRuns = include.has("runs")
      ? readRecentTaskRuns(driver, ref, taskEntry.taskId, limits.runLimit)
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
    const readConversation = include.has("conversation")
      ? readTaskConversationSegmentsFromDriver(driver, taskEntry.taskId)
      : Promise.resolve([]);
    const readConversationMarkdown = include.has("conversation")
      ? readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limits.conversationMarkdownCharLimit)
      : Promise.resolve("");

    const [task, state, assets, recentRuns, recentActions, recentCommits, recentEvidence, conversation, conversationMarkdownTail] = await Promise.all([
      readTask,
      readState,
      readAssets,
      readRuns,
      readActions,
      readCommits,
      readEvidence,
      readConversation,
      readConversationMarkdown,
    ]);

    if (include.has("task") && task) {
      detail.task = task;
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
      detail.conversation = tail(conversation, limits.conversationSegmentLimit);
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

    const taskEntry = await resolveTaskEntry(driver, input);
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
    const snapshot = await readTaskRoutingSnapshotFromDriver(driver, input.sessionId);
    const queryTokens = tokenizeSearchText(query);
    const matches = snapshot.tasks
      .filter((task) => !input.status || task.status === input.status)
      .map((task) => scoreTaskSearchMatch(task, query, queryTokens))
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
    const taskEntry = await resolveTaskEntry(driver, input);
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
      ? [await resolveTaskEntry(driver, input)]
      : await readTaskEntries(driver);
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
    const tasks = parseJson<GitMemoryTaskIndexFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
    ) ?? { schemaVersion: 1, tasks: [] };
    const taskId = input.taskId ?? createGitMemoryTaskId(date, tasks.tasks.length + 1);
    if (tasks.tasks.some((task) => task.taskId === taskId)) {
      throw new Error(`Git memory task already exists: ${taskId}`);
    }
    const branch = buildGitMemoryTaskBranchName(taskId, input.title);
    const ref = buildGitMemoryTaskBranchRef(taskId, input.title);
    if (await driver.hasRef(ref)) {
      throw new Error(`Git memory task branch already exists: ${ref}`);
    }

    const at = input.at ?? this.nowIso();
    const status = input.status ?? "open";
    const task: GitMemoryTaskFile = {
      schemaVersion: 1,
      taskId,
      title: input.title,
      objective: input.objective,
      status,
      createdAt: at,
      updatedAt: at,
      createdFrom: {
        sessionId: input.sessionId,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
      },
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
    const conversation = parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    );
    const taskConversation = conversationInRange(conversation, input);

    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      files: {
        [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: renderConversationMarkdownDocument(taskConversation, {
          taskId,
          runId: input.runId,
        }),
        [gitMemoryTaskFilePath(taskId)]: prettyJson(task),
        [gitMemoryTaskStatePath(taskId)]: prettyJson(state),
        [gitMemoryTaskAssetsPath(taskId)]: "",
        [gitMemoryTaskNotesPath(taskId)]: `# ${input.title}\n`,
        [gitMemoryTaskContextPath(taskId)]: "",
      },
      message: renderGitMemoryCommitMessage({
        subject: `ayati: create task ${taskId}`,
        summary: input.objective,
        trailers: {
          sessionId: input.sessionId,
          taskId,
          event: "task_created",
          status,
          at,
          branch,
          conversationSeq: { fromSeq: input.fromSeq, toSeq: input.toSeq },
          schemaVersion: 1,
        },
      }),
    });

    const previousFocus = parseJson<GitMemoryFocusFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_FOCUS_PATH),
    );
    const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
    );
    const taskEventSeq = nextSeq(existingEvents);
    const focusEventSeq = taskEventSeq + 1;
    const taskCreated: GitMemorySessionEventRecord = {
      v: 1,
      seq: taskEventSeq,
      eventId: createGitMemoryEventId(date, taskEventSeq),
      type: "task_created",
      at,
      taskId,
      branch,
      conversationSeq: { fromSeq: input.fromSeq, toSeq: input.toSeq },
    };
    const focusChanged: GitMemorySessionEventRecord = {
      v: 1,
      seq: focusEventSeq,
      eventId: createGitMemoryEventId(date, focusEventSeq),
      type: "focus_changed",
      at,
      fromTaskId: previousFocus?.activeTaskId ?? null,
      toTaskId: taskId,
      branch,
      reason: "task_created",
    };
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_TASKS_PATH]: prettyJson({
        schemaVersion: 1,
        tasks: [...tasks.tasks, {
          taskId,
          branch,
          title: input.title,
          status,
          createdAt: at,
          updatedAt: at,
        }],
      } satisfies GitMemoryTaskIndexFile),
      [GIT_MEMORY_SESSION_FOCUS_PATH]: prettyJson({
        schemaVersion: 1,
        activeTaskId: taskId,
        activeBranch: branch,
        updatedAt: at,
        reason: "task_created",
      } satisfies GitMemoryFocusFile),
      [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([...existingEvents, taskCreated, focusChanged]),
    });

    const link = await this.linkTaskMessages({
      sessionId: input.sessionId,
      taskId,
      branch,
      reason: "task_created",
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      at,
      runId: input.runId,
      summary: input.objective,
    });

    return { taskId, branch, ref, taskCommit, link };
  }

  async selectTaskForTurn(input: SelectGitMemoryTaskForTurnInput): Promise<SelectGitMemoryTaskForTurnResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const tasks = parseJson<GitMemoryTaskIndexFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
    ) ?? { schemaVersion: 1, tasks: [] };
    const taskEntry = tasks.tasks.find((task) => task.taskId === input.taskId);
    if (!taskEntry) {
      throw new Error(`Git memory task not found: ${input.taskId}`);
    }
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }

    const at = input.at ?? this.nowIso();
    const focus = parseJson<GitMemoryFocusFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_FOCUS_PATH),
    );
    const focusChanged = focus?.activeTaskId !== taskEntry.taskId || focus?.activeBranch !== taskEntry.branch;
    let focusEvent: GitMemorySessionEventRecord | undefined;
    if (focusChanged) {
      const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
        await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
      );
      const eventSeq = nextSeq(existingEvents);
      focusEvent = {
        v: 1,
        seq: eventSeq,
        eventId: createGitMemoryEventId(date, eventSeq),
        type: "focus_changed",
        at,
        fromTaskId: focus?.activeTaskId ?? null,
        toTaskId: taskEntry.taskId,
        branch: taskEntry.branch,
        reason: input.reason,
      };
      await driver.writeWorkingFiles({
        [GIT_MEMORY_SESSION_FOCUS_PATH]: prettyJson({
          schemaVersion: 1,
          activeTaskId: taskEntry.taskId,
          activeBranch: taskEntry.branch,
          updatedAt: at,
          reason: input.reason,
        } satisfies GitMemoryFocusFile),
        [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([...existingEvents, focusEvent]),
      });
    }

    const link = await this.linkTaskMessages({
      sessionId: input.sessionId,
      taskId: input.taskId,
      branch: taskEntry.branch,
      reason: input.reason,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      at,
      turnIds: input.turnIds,
      runId: input.runId,
      summary: input.summary,
    });

    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
      link,
      ...(focusEvent ? { focusEvent } : {}),
    };
  }

  async commitTaskRun(input: CommitGitMemoryTaskRunInput): Promise<CommitGitMemoryTaskRunResult> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const tasks = parseJson<GitMemoryTaskIndexFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
    ) ?? { schemaVersion: 1, tasks: [] };
    const taskIndex = tasks.tasks.findIndex((task) => task.taskId === input.taskId);
    if (taskIndex < 0) {
      throw new Error(`Git memory task not found: ${input.taskId}`);
    }
    const taskEntry = tasks.tasks[taskIndex];
    if (!taskEntry) {
      throw new Error(`Git memory task not found: ${input.taskId}`);
    }
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      throw new Error(`Git memory task branch missing: ${ref}`);
    }

    const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
    );
    const runId = input.runId ?? createGitMemoryRunId(date, nextRunSequence(existingEvents));
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
    const run: GitMemoryRunFile = {
      schemaVersion: 1,
      runId,
      taskId: input.taskId,
      status: input.status,
      startedAt,
      completedAt,
      conversationRefs: input.conversationRefs,
      summary: input.summary,
      ...(input.assistantResponse ? { assistantResponse: input.assistantResponse } : {}),
      toolCallCount: input.toolCallCount ?? actions.length,
      changedFiles: input.changedFiles ?? [],
      newFacts,
      ...(input.next ? { next: input.next } : {}),
    };
    const firstConversationRef = input.conversationRefs[0];
    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      files: {
        [gitMemoryTaskStatePath(input.taskId)]: prettyJson(updatedState),
        [gitMemoryTaskRunPath(input.taskId, runId)]: prettyJson(run),
        [gitMemoryTaskActionsPath(input.taskId, runId)]: jsonl(actions),
        [gitMemoryTaskEvidenceManifestPath(input.taskId, runId)]: jsonl(evidence),
      },
      message: renderGitMemoryCommitMessage({
        subject: `ayati: complete run ${runId}`,
        summary: input.summary,
        completed: updatedState.completed,
        open: updatedState.open,
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

    const eventSeq = nextSeq(existingEvents);
    const event: GitMemorySessionEventRecord = {
      v: 1,
      seq: eventSeq,
      eventId: createGitMemoryEventId(date, eventSeq),
      type: input.status === "failed" ? "run_failed" : "run_completed",
      at: completedAt,
      taskId: input.taskId,
      runId,
      branch: taskEntry.branch,
      commit: taskCommit,
      ...(firstConversationRef ? { conversationSeq: firstConversationRef } : {}),
    };
    const updatedTasks = tasks.tasks.map((task, index) => index === taskIndex
      ? {
          ...task,
          status: updatedState.status,
          updatedAt: completedAt,
        }
      : task);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([...existingEvents, event]),
      [GIT_MEMORY_SESSION_TASKS_PATH]: prettyJson({
        schemaVersion: 1,
        tasks: updatedTasks,
      } satisfies GitMemoryTaskIndexFile),
    });

    return {
      taskId: input.taskId,
      branch: taskEntry.branch,
      ref,
      runId,
      taskCommit,
      event,
    };
  }

  async checkpointSession(input: GitMemorySessionCheckpointInput): Promise<GitMemorySessionCheckpoint> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(input.sessionId));
    const date = gitMemoryDateFromSessionId(input.sessionId);
    const at = input.at ?? this.nowIso();
    const existingEvents = parseJsonl<GitMemorySessionEventRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_EVENTS_PATH),
    );
    const eventSeq = nextSeq(existingEvents);
    const event: GitMemorySessionEventRecord = {
      v: 1,
      seq: eventSeq,
      eventId: createGitMemoryEventId(date, eventSeq),
      type: "session_checkpointed",
      at,
    };
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([...existingEvents, event]),
    });

    const commit = await driver.commitPaths([
      GIT_MEMORY_SESSION_CONVERSATION_PATH,
      GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
      GIT_MEMORY_SESSION_EVENTS_PATH,
      GIT_MEMORY_SESSION_FOCUS_PATH,
      GIT_MEMORY_SESSION_TASKS_PATH,
      GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
    ], renderGitMemoryCommitMessage({
      subject: `ayati: checkpoint session ${input.sessionId}`,
      summary: input.summary ?? "Commit accumulated session git-context changes.",
      trailers: {
        sessionId: input.sessionId,
        event: "session_checkpointed",
        at,
        schemaVersion: 1,
      },
    }));
    if (!commit) {
      throw new Error("Session checkpoint did not contain changes.");
    }
    return { event, commit };
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

function buildInitialSessionFiles(input: BuildInitialSessionFilesInput): Record<string, string> {
  const meta: GitMemorySessionMetaFile = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    date: input.date,
    timezone: input.timezone,
    createdAt: input.createdAt,
    repoKind: "daily_session",
    agentId: input.agentId,
  };
  const initialized: GitMemorySessionEventRecord = {
    v: 1,
    seq: 1,
    eventId: createGitMemoryEventId(input.date, 1),
    type: "session_initialized",
    at: input.createdAt,
  };
  const focus: GitMemoryFocusFile = {
    schemaVersion: 1,
    activeTaskId: null,
    activeBranch: null,
    updatedAt: input.createdAt,
    reason: "session_initialized",
  };
  const tasks: GitMemoryTaskIndexFile = {
    schemaVersion: 1,
    tasks: [],
  };

  return {
    [GIT_MEMORY_SESSION_META_PATH]: prettyJson(meta),
    [GIT_MEMORY_SESSION_CONVERSATION_PATH]: "",
    [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: "# Conversation\n",
    [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([initialized]),
    [GIT_MEMORY_SESSION_FOCUS_PATH]: prettyJson(focus),
    [GIT_MEMORY_SESSION_TASKS_PATH]: prettyJson(tasks),
    [GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH]: "",
    [GIT_MEMORY_SESSION_SCHEMA_PATH]: prettyJson({
      schemaVersion: 1,
      kind: "git_memory_session",
      sourceOfTruth: "git_files",
      commitPolicy: "checkpoint_boundaries",
    }),
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl<T>(records: T[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function appendConversationMarkdown(
  existing: string | null,
  record: GitMemoryConversationRecord,
): string {
  return appendConversationMarkdownRecords(existing, [record]);
}

interface ConversationMarkdownMetadata {
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

function renderConversationMarkdownDocument(
  records: GitMemoryConversationRecord[],
  metadata: ConversationMarkdownMetadata = {},
): string {
  return appendConversationMarkdownRecords("# Conversation\n", records, metadata);
}

function appendConversationMarkdownRecords(
  existing: string | null,
  records: GitMemoryConversationRecord[],
  metadata: ConversationMarkdownMetadata = {},
): string {
  const base = existing?.trimEnd() || "# Conversation";
  let output = base;
  for (const record of records) {
    const block = renderConversationMarkdownBlock(record, metadata).trimEnd();
    if (!output.includes(block)) {
      output = `${output}\n\n${block}`;
    }
  }
  return `${output.trimEnd()}\n`;
}

function renderConversationMarkdownBlock(
  record: GitMemoryConversationRecord,
  metadata: ConversationMarkdownMetadata = {},
): string {
  const taskId = metadata.taskId ?? record.taskId ?? undefined;
  const runId = metadata.runId ?? record.runId ?? undefined;
  const lines = [
    `## ${record.at} ${capitalizeRole(record.role)}`,
    "",
  ];
  if (taskId) {
    lines.push(`Task: ${taskId}`);
  }
  if (runId) {
    lines.push(`Run: ${runId}`);
  }
  if (taskId || runId) {
    lines.push("");
  }
  lines.push(record.text?.trim() || `[content: ${record.contentRef ?? "unavailable"}]`);
  return `${lines.join("\n")}\n`;
}

function capitalizeRole(role: GitMemoryConversationRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
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

async function readRefJson<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readFile(ref, path));
}

async function readRefJsonl<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T[]> {
  return parseJsonl<T>(await driver.readFile(ref, path));
}

async function readRefMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  path: string,
  limit: number,
): Promise<string> {
  return markdownTail(await driver.readFile(ref, path), limit);
}

async function readTaskRoutingSnapshotFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryTaskRoutingSnapshot> {
  const [tasks, focus] = await Promise.all([
    parseJson<GitMemoryTaskIndexFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
    ) ?? { schemaVersion: 1, tasks: [] },
    parseJson<GitMemoryFocusFile>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_FOCUS_PATH),
    ),
  ]);

  const snapshotTasks: GitMemoryTaskRoutingSnapshotTask[] = [];
  for (const taskEntry of tasks.tasks) {
    const ref = `refs/heads/${taskEntry.branch}`;
    if (!(await driver.hasRef(ref))) {
      snapshotTasks.push({
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
      });
      continue;
    }

    const [task, state] = await Promise.all([
      parseJson<GitMemoryTaskFile>(
        await driver.readFile(ref, gitMemoryTaskFilePath(taskEntry.taskId)),
      ),
      parseJson<GitMemoryTaskStateFile>(
        await driver.readFile(ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      ),
    ]);
    snapshotTasks.push({
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
      ...(!task || !state ? { missing: true } : {}),
    });
  }

  return {
    sessionId,
    focus,
    tasks: snapshotTasks,
  };
}

async function resolveTaskEntry(
  driver: GitMemoryWorktreeGitDriver,
  input: { taskId?: GitMemoryTaskId; branch?: string },
): Promise<GitMemoryTaskIndexFile["tasks"][number]> {
  const hasTaskId = Boolean(input.taskId?.trim());
  const hasBranch = Boolean(input.branch?.trim());
  if (hasTaskId === hasBranch) {
    throw new Error("Provide exactly one task selector: taskId or branch.");
  }

  const tasks = parseJson<GitMemoryTaskIndexFile>(
    await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
  ) ?? { schemaVersion: 1, tasks: [] };
  const entry = hasTaskId
    ? tasks.tasks.find((task) => task.taskId === input.taskId)
    : tasks.tasks.find((task) => task.branch === input.branch);
  if (!entry) {
    throw new Error(hasTaskId
      ? `Git memory task not found: ${input.taskId}`
      : `Git memory task branch not found: ${input.branch}`);
  }
  return entry;
}

async function readTaskEntries(driver: GitMemoryWorktreeGitDriver): Promise<GitMemoryTaskIndexFile["tasks"]> {
  return (parseJson<GitMemoryTaskIndexFile>(
    await driver.readWorkingFile(GIT_MEMORY_SESSION_TASKS_PATH),
  ) ?? { schemaVersion: 1, tasks: [] }).tasks;
}

function normalizeTaskDetailInclude(input: GitMemoryTaskDetailInclude[] | undefined): Set<GitMemoryTaskDetailInclude> {
  return new Set(input && input.length > 0
    ? input
    : ["task", "state", "runs", "actions", "assets", "commits", "evidence", "conversation"]);
}

function normalizeTaskDetailLimits(input: Partial<GitMemoryTaskDetailLimits> | undefined): GitMemoryTaskDetailLimits {
  return {
    runLimit: normalizeReadLimit(input?.runLimit, 5),
    actionRunLimit: normalizeReadLimit(input?.actionRunLimit, 3),
    actionLimit: normalizeReadLimit(input?.actionLimit, 20),
    commitLogLimit: normalizeReadLimit(input?.commitLogLimit, 10),
    evidenceLimit: normalizeReadLimit(input?.evidenceLimit, 20),
    conversationSegmentLimit: normalizeReadLimit(input?.conversationSegmentLimit, 5),
    conversationMarkdownCharLimit: normalizeReadLimit(input?.conversationMarkdownCharLimit, 12_000),
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

async function readTaskConversationSegmentsFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  taskId: GitMemoryTaskId,
): Promise<GitMemoryTaskConversationSegment[]> {
  const [conversation, links] = await Promise.all([
    parseJsonl<GitMemoryConversationRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH),
    ),
    parseJsonl<GitMemoryTaskMessageLinkRecord>(
      await driver.readWorkingFile(GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH),
    ),
  ]);
  return links
    .filter((link) => link.taskId === taskId)
    .map((link) => ({
      link,
      messages: conversationInRange(conversation, link),
    }));
}

function scoreTaskSearchMatch(
  task: GitMemoryTaskRoutingSnapshotTask,
  rawQuery: string,
  queryTokens: string[],
): GitMemoryTaskSearchMatch {
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
    { reason: "open", weight: 5, values: task.open },
    { reason: "blockers", weight: 5, values: task.blockers },
    { reason: "status", weight: 3, values: [task.status] },
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

function conversationInRange(
  conversation: GitMemoryConversationRecord[],
  range: GitMemoryConversationSeqRange,
): GitMemoryConversationRecord[] {
  return conversation.filter((message) => message.seq >= range.fromSeq && message.seq <= range.toSeq);
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

function nextRunSequence(events: GitMemorySessionEventRecord[]): number {
  const sequences = events
    .map((event) => event.runId)
    .filter((runId): runId is GitMemoryRunId => typeof runId === "string" && runId.length > 0)
    .map((runId) => Number(runId.split("-")[2] ?? "0"))
    .filter((sequence) => Number.isInteger(sequence) && sequence > 0);
  return Math.max(0, ...sequences) + 1;
}

function actionSequenceForRun(runId: GitMemoryRunId, actionIndex: number): number {
  const runSequence = Number(runId.split("-")[2] ?? "0");
  return runSequence * 100 + actionIndex + 1;
}
