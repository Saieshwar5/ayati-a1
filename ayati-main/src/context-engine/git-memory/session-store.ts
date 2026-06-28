import { join } from "node:path";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { renderGitMemoryCommitMessage } from "./commit-message.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryConversationSeqRange,
  GitMemoryFocusFile,
  GitMemoryRunId,
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
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
  buildGitMemoryTaskBranchName,
  buildGitMemoryTaskBranchRef,
  createGitMemoryEventId,
  createGitMemoryLinkId,
  createGitMemoryMessageId,
  createGitMemorySessionId,
  createGitMemoryTaskId,
  createGitMemoryTurnId,
  gitMemoryDateFromSessionId,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskContextPath,
  gitMemoryTaskFilePath,
  gitMemoryTaskNotesPath,
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

export interface CreateGitMemoryTaskBranchInput extends GitMemoryConversationSeqRange {
  sessionId: GitMemorySessionId;
  title: string;
  objective: string;
  taskId?: GitMemoryTaskId;
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
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_CONVERSATION_PATH]: jsonl([...existing, record]),
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

  async readTaskConversationSegments(
    sessionId: GitMemorySessionId,
    taskId: GitMemoryTaskId,
  ): Promise<GitMemoryTaskConversationSegment[]> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
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

    const taskCommit = await driver.commitSyntheticFiles({
      ref,
      files: {
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
      summary: input.objective,
    });

    return { taskId, branch, ref, taskCommit, link };
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
      GIT_MEMORY_SESSION_EVENTS_PATH,
      GIT_MEMORY_SESSION_FOCUS_PATH,
      GIT_MEMORY_SESSION_TASKS_PATH,
      GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
    ], renderGitMemoryCommitMessage({
      subject: `ayati: checkpoint session ${input.sessionId}`,
      summary: input.summary ?? "Commit accumulated session memory changes.",
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

function conversationInRange(
  conversation: GitMemoryConversationRecord[],
  range: GitMemoryConversationSeqRange,
): GitMemoryConversationRecord[] {
  return conversation.filter((message) => message.seq >= range.fromSeq && message.seq <= range.toSeq);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function nextSeq(records: Array<{ seq?: unknown }>): number {
  return records.reduce((max, record) => (
    typeof record.seq === "number" && Number.isInteger(record.seq) ? Math.max(max, record.seq) : max
  ), 0) + 1;
}
