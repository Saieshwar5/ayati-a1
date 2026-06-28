import { join } from "node:path";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { renderGitMemoryCommitMessage } from "./commit-message.js";
import type {
  GitMemoryActionId,
  GitMemoryActionRecord,
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryConversationSeqRange,
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
  gitMemoryTaskAssetsPath,
  gitMemoryTaskActionsPath,
  gitMemoryTaskContextPath,
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
    return { runId: input.runId, event };
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

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    const driver = await GitMemoryWorktreeGitDriver.init(this.repoPath(sessionId));
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
