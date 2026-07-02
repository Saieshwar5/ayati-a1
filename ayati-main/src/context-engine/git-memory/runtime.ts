import type {
  TaskAssetRecord,
} from "../contracts.js";
import type {
  CommitGitMemoryTaskRunInput,
  CommitGitMemoryTaskRunResult,
  CreateGitMemoryTaskBranchInput,
  CreateGitMemoryTaskBranchResult,
  GitMemoryDailySessionHandle,
  GitMemorySessionCheckpoint,
  GitMemoryTaskRoutingSnapshot,
  SelectGitMemoryTaskForTurnResult,
} from "./session-store.js";
import { GitMemoryDailySessionStore } from "./session-store.js";
import {
  buildGitMemoryTaskRunCommitInput,
  type BuildGitMemoryTaskRunCommitInput,
} from "./harness-result-mapper.js";
import {
  DEFAULT_GIT_MEMORY_CONTEXT_LIMITS,
  type GitMemoryPendingTurnContext,
  type GitMemoryMachineContextPack,
} from "./context-pack.js";
import {
  appendGitMemoryConversationMarkdown,
  appendGitMemoryConversationMarkdownRecords,
  renderGitMemoryConversationMarkdownDocument,
} from "./conversation-markdown.js";
import {
  buildGitMemoryContextPackFromMemoryState,
  buildGitContextPendingWrites,
  GitContextMemoryStateHydrator,
  type GitContextMemoryActiveTask,
  type GitContextMemoryState,
} from "./memory-state.js";
import {
  GitMemoryTaskRouter,
  type AppliedGitMemoryTaskRoute,
  type ApplyGitMemoryTaskRouteInput,
  type GitMemoryTaskRouteCandidate,
  type GitMemoryTaskRouteResolution,
  type ResolveGitMemoryTaskRouteInput,
  isGitMemoryPureFollowUpMessage,
} from "./task-router.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryConversationSeqRange,
  GitMemoryRunFile,
  GitMemoryRunId,
  GitMemorySessionAttachmentRecord,
  GitMemorySessionAttachmentsFile,
  GitMemorySessionId,
  GitMemoryTaskId,
} from "./schema.js";
import { createGitMemorySessionId } from "./schema.js";
import {
  GitMemoryWriteQueue,
  type GitMemoryWriteBatchRequest,
  type GitMemoryWriteBatchSnapshot,
  type GitMemoryWriteQueueRunner,
} from "./write-queue.js";

export interface GitMemoryRuntimeOptions {
  contextStoreDir: string;
  timezone: string;
  agentId: string;
  now?: () => Date;
  store?: GitMemoryDailySessionStore;
  taskRouter?: GitMemoryTaskRouter;
  writeQueue?: GitMemoryWriteQueueRunner;
}

export interface OpenGitMemoryRuntimeSessionInput {
  at?: string;
}

export interface PrepareGitMemoryUserTurnInput {
  userMessage: string;
  at?: string;
}

export interface PreparedGitMemoryUserTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  userMessage: GitMemoryConversationRecord;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface PrepareGitMemorySystemTurnInput {
  systemMessage: string;
  at?: string;
}

export interface PreparedGitMemorySystemTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  systemMessage: GitMemoryConversationRecord;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface PendingGitMemoryTurnEnvelope extends GitMemoryPendingTurnContext {
  sessionId: GitMemorySessionId;
}

export interface RecordGitMemoryAssistantMessageInput {
  sessionId: GitMemorySessionId;
  text: string;
  kind?: GitMemoryConversationRecord["kind"];
  at?: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface RecordGitMemorySessionAttachmentsInput {
  sessionId: GitMemorySessionId;
  attachments: GitMemorySessionAttachmentRecord[];
  at?: string;
}

export interface CheckpointGitMemoryRuntimeSessionInput {
  sessionId: GitMemorySessionId;
  summary?: string;
  at?: string;
}

export interface FinalizeGitMemoryTaskRunInput extends BuildGitMemoryTaskRunCommitInput {
  assistantMessage?: string;
  assistantMessageKind?: GitMemoryConversationRecord["kind"];
  assistantAt?: string;
}

export interface FinalizeGitMemoryTaskRunResult extends CommitGitMemoryTaskRunResult {
  alreadyFinalized: boolean;
  assistantMessage?: GitMemoryConversationRecord;
}

export interface SwitchGitMemoryTaskInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  reason?: string;
  at?: string;
}

export interface SwitchGitMemoryTaskResult extends SelectGitMemoryTaskForTurnResult {
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface ActivateGitMemoryTaskForTurnInput {
  sessionId: GitMemorySessionId;
  taskId: GitMemoryTaskId;
  reason: string;
  at?: string;
}

export interface CreateGitMemoryTaskForTurnInput {
  sessionId: GitMemorySessionId;
  title: string;
  objective: string;
  reason: string;
  at?: string;
}

export interface AskGitMemoryTaskClarificationForTurnInput {
  sessionId: GitMemorySessionId;
  reason: string;
  candidateTaskIds?: GitMemoryTaskId[];
  at?: string;
}

export type RoutedGitMemoryUserTurn =
  | (Extract<AppliedGitMemoryTaskRoute, { status: "ready" }> & {
      runId: GitMemoryRunId;
      context: GitMemoryMachineContextPack;
      memoryState: GitContextMemoryState;
    })
  | (Extract<AppliedGitMemoryTaskRoute, { status: "ambiguous" }> & {
      context: GitMemoryMachineContextPack;
      memoryState: GitContextMemoryState;
    });

export class GitMemoryRuntime {
  private readonly timezone: string;
  private readonly agentId: string;
  private readonly nowProvider: () => Date;
  private readonly store: GitMemoryDailySessionStore;
  private readonly memoryStateHydrator: GitContextMemoryStateHydrator;
  private readonly taskRouter: GitMemoryTaskRouter;
  private readonly writeQueue: GitMemoryWriteQueueRunner;
  private readonly sessionMemoryCache = new Map<GitMemorySessionId, GitContextMemoryState>();
  private readonly pendingTurns = new Map<GitMemorySessionId, PendingGitMemoryTurnEnvelope>();

  constructor(options: GitMemoryRuntimeOptions) {
    this.timezone = options.timezone;
    this.agentId = options.agentId;
    this.nowProvider = options.now ?? (() => new Date());
    this.store = options.store ?? new GitMemoryDailySessionStore({
      contextStoreDir: options.contextStoreDir,
      now: this.nowProvider,
    });
    this.memoryStateHydrator = new GitContextMemoryStateHydrator(this.store);
    this.taskRouter = options.taskRouter ?? new GitMemoryTaskRouter(this.store);
    this.writeQueue = options.writeQueue ?? new GitMemoryWriteQueue();
  }

  async openDailySession(input: OpenGitMemoryRuntimeSessionInput = {}): Promise<GitMemoryDailySessionHandle> {
    const at = input.at ?? this.nowProvider().toISOString();
    const sessionId = this.sessionIdForAt(at);
    return await this.writeQueue.enqueue({
      sessionId,
      type: "session_opened",
      label: "open_daily_session",
      createdAt: at,
    }, async () => {
      return await this.openDailySessionUnqueued(at);
    });
  }

  private async openDailySessionUnqueued(at: string): Promise<GitMemoryDailySessionHandle> {
    return await this.store.openOrCreateDailySession({
      date: sessionDateForAt(at, this.timezone),
      timezone: this.timezone,
      agentId: this.agentId,
      createdAt: at,
    });
  }

  async prepareUserTurn(input: PrepareGitMemoryUserTurnInput): Promise<PreparedGitMemoryUserTurn> {
    const at = input.at ?? this.nowProvider().toISOString();
    const sessionId = this.sessionIdForAt(at);
    const session = await this.openDailySessionUnqueued(at);
    const userMessage = await this.createAndCacheConversationRecord(session.sessionId, {
      role: "user",
      text: input.userMessage,
      at,
    });
    this.enqueueGlobalConversationPersistence({
      sessionId,
      label: "prepare_user_turn",
      type: "main_conversation_appended",
      createdAt: at,
      record: userMessage,
    });
    this.clearUnboundPendingTurn(session.sessionId);
    const memoryState = await this.hydrateMemoryState(session.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      status: "ready",
      sessionId: session.sessionId,
      repoPath: session.repoPath,
      initialized: session.initialized,
      userMessage,
      context,
      memoryState,
    };
  }

  async prepareSystemTurn(input: PrepareGitMemorySystemTurnInput): Promise<PreparedGitMemorySystemTurn> {
    const at = input.at ?? this.nowProvider().toISOString();
    const sessionId = this.sessionIdForAt(at);
    const session = await this.openDailySessionUnqueued(at);
    const systemMessage = await this.createAndCacheConversationRecord(session.sessionId, {
      role: "system",
      text: input.systemMessage,
      at,
    });
    this.enqueueGlobalConversationPersistence({
      sessionId,
      label: "prepare_system_turn",
      type: "main_conversation_appended",
      createdAt: at,
      record: systemMessage,
    });
    const memoryState = await this.hydrateMemoryState(session.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      status: "ready",
      sessionId: session.sessionId,
      repoPath: session.repoPath,
      initialized: session.initialized,
      systemMessage,
      context,
      memoryState,
    };
  }

  async recordAssistantMessage(
    input: RecordGitMemoryAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord> {
    const at = input.at ?? this.nowProvider().toISOString();
    const cachedState = input.taskId
      ? null
      : await this.getOrHydrateCachedMemoryState(input.sessionId);
    if (cachedState) {
      const record = await this.createAndCacheConversationRecord(input.sessionId, {
        role: "assistant",
        ...(input.kind ? { kind: input.kind } : {}),
        text: input.text,
        at,
      });
      this.enqueueGlobalConversationPersistence({
        sessionId: input.sessionId,
        label: "record_assistant_message",
        type: "assistant_message_recorded",
        createdAt: at,
        record,
      });
      return record;
    }
    const record = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "assistant_message_recorded",
      label: "record_assistant_message",
      createdAt: at,
    }, async () => {
      const record = await this.store.appendConversationMessage({
	        sessionId: input.sessionId,
	        role: "assistant",
	        ...(input.kind ? { kind: input.kind } : {}),
	        text: input.text,
        at,
        taskId: input.taskId,
        runId: input.runId,
      });
      return record;
    });
    if (!this.updateCachedTaskConversation(input.sessionId, input.taskId, record)) {
      this.invalidateSessionMemory(input.sessionId);
    }
    return record;
  }

  async recordSessionAttachments(
    input: RecordGitMemorySessionAttachmentsInput,
  ): Promise<GitMemorySessionAttachmentsFile> {
    const at = input.at ?? this.nowProvider().toISOString();
    const result = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "session_attachments_recorded",
      label: "record_session_attachments",
      createdAt: at,
    }, async () => {
      return await this.store.upsertSessionAttachments({
        sessionId: input.sessionId,
        attachments: input.attachments,
        updatedAt: at,
      });
    });
    this.invalidateSessionMemory(input.sessionId);
    return result;
  }

  async createTaskBranch(input: CreateGitMemoryTaskBranchInput): Promise<CreateGitMemoryTaskBranchResult> {
    const result = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_created",
      label: "create_task_branch",
      createdAt: input.at,
    }, async () => {
      return await this.store.createTaskBranch(input);
    });
    await this.cacheCreatedTask(input, result);
    return result;
  }

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    return await this.store.readTaskRoutingSnapshot(sessionId);
  }

  async resolveTaskRoute(input: ResolveGitMemoryTaskRouteInput): Promise<GitMemoryTaskRouteResolution> {
    return await this.taskRouter.resolve(input);
  }

  async continueActiveTurn(input: ApplyGitMemoryTaskRouteInput): Promise<RoutedGitMemoryUserTurn | null> {
    if (!isGitMemoryPureFollowUpMessage(input.userMessage)) {
      return null;
    }

    const pendingTurn = this.ensureUnboundPendingTurn(input.sessionId, input);
    if (
      pendingTurn.routingStatus !== "unbound"
      || !sameConversationRange(pendingTurn, input)
    ) {
      return null;
    }

    const state = await this.getOrHydrateCachedMemoryState(input.sessionId);
    if (state.focus.status !== "active" || !state.activeTask) {
      return null;
    }

    const activeTask = state.activeTask;
    const mode: "continue_active_task" | "reopen_existing_task" = isReopenTaskStatus(activeTask.status)
      ? "reopen_existing_task"
      : "continue_active_task";
    const selectedReason: "task_continued" | "task_reopened" = mode === "reopen_existing_task"
      ? "task_reopened"
      : "task_continued";
    const reason = mode === "reopen_existing_task"
      ? "obvious follow-up to completed active task"
      : "obvious follow-up to active task";
    const routed = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_routed",
      label: "continue_active_turn",
      createdAt: input.at,
    }, async () => {
      const runId = await this.store.allocateTaskRunId(input.sessionId);
      const selectedTask = await this.store.selectTaskForTurn({
        sessionId: input.sessionId,
        taskId: activeTask.taskId,
        reason: selectedReason,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        at: input.at,
        runId,
        summary: reason,
      });
      await this.store.startTaskRun({
        sessionId: input.sessionId,
        taskId: selectedTask.taskId,
        branch: selectedTask.branch,
        runId,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        at: input.at,
      });
      return {
        status: "ready" as const,
        mode,
        sessionId: input.sessionId,
        taskId: selectedTask.taskId,
        branch: selectedTask.branch,
        ref: selectedTask.ref,
        conversationRefs: [{ fromSeq: input.fromSeq, toSeq: input.toSeq }],
        confidence: "deterministic" as const,
        reason,
        selectedTask,
        runId,
      };
    });
    this.bindPendingTurn(input.sessionId, {
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      taskId: routed.taskId,
      branch: routed.branch,
      runId: routed.runId,
    });
    if (!await this.cacheRoutedTaskTurn(input, routed)) {
      this.invalidateSessionMemory(input.sessionId);
    }
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      ...routed,
      context,
      memoryState,
    };
  }

  async activateTaskForTurn(input: ActivateGitMemoryTaskForTurnInput): Promise<RoutedGitMemoryUserTurn> {
    const pendingTurn = await this.requireOrCreateUnboundPendingTurn(input.sessionId, input.at);
    const state = await this.getOrHydrateCachedMemoryState(input.sessionId);
    const knownTask = state.knownTasks.find((task) => task.taskId === input.taskId);
    const mode: "continue_active_task" | "switch_to_existing_task" | "reopen_existing_task" =
      knownTask && isReopenTaskStatus(knownTask.status)
        ? "reopen_existing_task"
        : state.focus.status === "active" && state.focus.taskId === input.taskId
          ? "continue_active_task"
          : "switch_to_existing_task";
    const selectedReason: "task_continued" | "task_switched" | "task_reopened" =
      mode === "reopen_existing_task"
        ? "task_reopened"
        : mode === "continue_active_task"
          ? "task_continued"
          : "task_switched";
    const at = input.at ?? pendingTurn.at;
    const routed = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_routed",
      label: "activate_task_for_turn",
      createdAt: at,
    }, async () => {
      const runId = await this.store.allocateTaskRunId(input.sessionId);
      const selectedTask = await this.store.selectTaskForTurn({
        sessionId: input.sessionId,
        taskId: input.taskId,
        reason: selectedReason,
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
        at,
        runId,
        summary: input.reason,
      });
      await this.store.startTaskRun({
        sessionId: input.sessionId,
        taskId: selectedTask.taskId,
        branch: selectedTask.branch,
        runId,
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
        at,
      });
      return {
        status: "ready" as const,
        mode,
        sessionId: input.sessionId,
        taskId: selectedTask.taskId,
        branch: selectedTask.branch,
        ref: selectedTask.ref,
        conversationRefs: [{ fromSeq: pendingTurn.fromSeq, toSeq: pendingTurn.toSeq }],
        confidence: "deterministic" as const,
        reason: input.reason,
        selectedTask,
        runId,
      };
    });
    this.bindPendingTurn(input.sessionId, {
      fromSeq: pendingTurn.fromSeq,
      toSeq: pendingTurn.toSeq,
      taskId: routed.taskId,
      branch: routed.branch,
      runId: routed.runId,
    });
    if (!await this.cacheRoutedTaskTurn({
      sessionId: input.sessionId,
      userMessage: pendingTurn.text,
      fromSeq: pendingTurn.fromSeq,
      toSeq: pendingTurn.toSeq,
      at,
    }, routed)) {
      this.invalidateSessionMemory(input.sessionId);
    }
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      ...routed,
      context,
      memoryState,
    };
  }

  async createTaskForTurn(input: CreateGitMemoryTaskForTurnInput): Promise<RoutedGitMemoryUserTurn> {
    const pendingTurn = await this.requireOrCreateUnboundPendingTurn(input.sessionId, input.at);
    const at = input.at ?? pendingTurn.at;
    const routed = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_routed",
      label: "create_task_for_turn",
      createdAt: at,
    }, async () => {
      const runId = await this.store.allocateTaskRunId(input.sessionId);
      const createdTask = await this.store.createTaskBranch({
        sessionId: input.sessionId,
        title: input.title,
        objective: input.objective,
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
        at,
        runId,
        state: {
          status: "open",
          summary: input.objective,
          completed: [],
          open: [input.objective],
          blockers: [],
          facts: [],
          next: input.objective,
        },
      });
      await this.store.startTaskRun({
        sessionId: input.sessionId,
        taskId: createdTask.taskId,
        branch: createdTask.branch,
        runId,
        fromSeq: pendingTurn.fromSeq,
        toSeq: pendingTurn.toSeq,
        at,
      });
      return {
        status: "ready" as const,
        mode: "create_new_task" as const,
        sessionId: input.sessionId,
        taskId: createdTask.taskId,
        branch: createdTask.branch,
        ref: createdTask.ref,
        conversationRefs: [{ fromSeq: pendingTurn.fromSeq, toSeq: pendingTurn.toSeq }],
        confidence: "deterministic" as const,
        reason: input.reason,
        createdTask,
        runId,
      };
    });
    this.bindPendingTurn(input.sessionId, {
      fromSeq: pendingTurn.fromSeq,
      toSeq: pendingTurn.toSeq,
      taskId: routed.taskId,
      branch: routed.branch,
      runId: routed.runId,
    });
    if (!await this.cacheRoutedTaskTurn({
      sessionId: input.sessionId,
      userMessage: pendingTurn.text,
      fromSeq: pendingTurn.fromSeq,
      toSeq: pendingTurn.toSeq,
      at,
      title: input.title,
      objective: input.objective,
    }, routed)) {
      this.invalidateSessionMemory(input.sessionId);
    }
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      ...routed,
      context,
      memoryState,
    };
  }

  async askClarificationForTurn(
    input: AskGitMemoryTaskClarificationForTurnInput,
  ): Promise<Extract<RoutedGitMemoryUserTurn, { status: "ambiguous" }>> {
    const pendingTurn = await this.requireOrCreateUnboundPendingTurn(input.sessionId, input.at);
    const candidates = await this.taskRouteCandidatesForIds(
      input.sessionId,
      input.candidateTaskIds ?? [],
      input.reason,
    );
    this.markPendingTurnClarifying(input.sessionId, {
      fromSeq: pendingTurn.fromSeq,
      toSeq: pendingTurn.toSeq,
    });
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      status: "ambiguous",
      sessionId: input.sessionId,
      candidates,
      reason: input.reason,
      context,
      memoryState,
    };
  }

  async switchTask(input: SwitchGitMemoryTaskInput): Promise<SwitchGitMemoryTaskResult> {
    const result = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_switched",
      label: "switch_task",
      createdAt: input.at,
    }, async () => {
      return await this.store.selectTaskForTurn({
        sessionId: input.sessionId,
        taskId: input.taskId,
        fromSeq: 0,
        toSeq: 0,
        reason: "task_switched",
        at: input.at,
        summary: input.reason,
      });
    });
    this.invalidateSessionMemory(input.sessionId);
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      ...result,
      context,
      memoryState,
    };
  }

  async routeUserTurn(input: ApplyGitMemoryTaskRouteInput): Promise<RoutedGitMemoryUserTurn> {
    this.ensureUnboundPendingTurn(input.sessionId, input);
    const routed = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_routed",
      label: "route_user_turn",
      createdAt: input.at,
    }, async () => {
      const resolution = await this.taskRouter.resolve(input);
      if (resolution.mode === "ambiguous") {
        return {
          status: "ambiguous",
          sessionId: input.sessionId,
          candidates: resolution.candidates,
          reason: resolution.reason,
        } as const;
      }
      const runId = await this.store.allocateTaskRunId(input.sessionId);
      const route = await this.taskRouter.applyResolution({ ...input, runId }, resolution);
      if (route.status === "ambiguous") {
        throw new Error("Git memory task route unexpectedly became ambiguous after run allocation.");
      }
      await this.store.startTaskRun({
        sessionId: input.sessionId,
        taskId: route.taskId,
        branch: route.branch,
        runId,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        at: input.at,
      });
      return {
        ...route,
        runId,
      };
    });
    if (routed.status === "ready") {
      this.bindPendingTurn(input.sessionId, {
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        taskId: routed.taskId,
        branch: routed.branch,
        runId: routed.runId,
      });
      if (!await this.cacheRoutedTaskTurn(input, routed)) {
        this.invalidateSessionMemory(input.sessionId);
      }
    } else {
      this.markPendingTurnClarifying(input.sessionId, {
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
      });
    }
    const memoryState = await this.hydrateMemoryState(input.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      ...routed,
      context,
      memoryState,
    };
  }

  async commitTaskRun(input: CommitGitMemoryTaskRunInput): Promise<CommitGitMemoryTaskRunResult> {
    const result = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "task_run_committed",
      label: "commit_task_run",
      createdAt: input.completedAt,
    }, async () => {
      return await this.store.commitTaskRun(input);
    });
    if (!await this.cacheCommittedTaskRun(input, result)) {
      this.invalidateSessionMemory(input.sessionId);
    }
    this.clearCommittedPendingTurn(input.sessionId, result.runId);
    return result;
  }

  async finalizeTaskRun(input: FinalizeGitMemoryTaskRunInput): Promise<FinalizeGitMemoryTaskRunResult> {
    const baseCommitInput = buildGitMemoryTaskRunCommitInput(input);
    const finalized = await this.writeQueue.enqueue({
      sessionId: baseCommitInput.sessionId,
      type: "task_run_committed",
      label: "finalize_task_run",
      createdAt: baseCommitInput.completedAt,
    }, async () => {
      const existing = baseCommitInput.runId
        ? await this.store.readCommittedTaskRun({
          sessionId: baseCommitInput.sessionId,
          taskId: baseCommitInput.taskId,
          runId: baseCommitInput.runId,
        })
        : null;
      if (existing) {
        return {
          result: existing,
          alreadyFinalized: true,
          assistantMessage: undefined,
        };
      }
      let assistantMessage: GitMemoryConversationRecord | undefined;
      let commitInput = baseCommitInput;
      if (input.assistantMessage?.trim()) {
        assistantMessage = await this.store.appendConversationMessage({
	        sessionId: baseCommitInput.sessionId,
	        text: input.assistantMessage,
	        ...(input.assistantMessageKind ? { kind: input.assistantMessageKind } : {}),
	        at: input.assistantAt ?? input.at,
          taskId: baseCommitInput.taskId,
          ...(baseCommitInput.runId ? { runId: baseCommitInput.runId } : {}),
          role: "assistant",
        });
        commitInput = {
          ...baseCommitInput,
          conversationRefs: includeConversationRecordInRefs(baseCommitInput.conversationRefs, assistantMessage),
        };
      }
      const snapshot = await this.store.commitSessionStoreSnapshot({
        sessionId: commitInput.sessionId,
        at: commitInput.completedAt,
        summary: `Snapshot conversation for task run ${commitInput.runId ?? "unknown"}.`,
      });
      return {
        result: await this.store.commitTaskRun({
          ...commitInput,
          sessionStoreCommit: snapshot.sessionStoreCommit,
        }),
        alreadyFinalized: false,
        assistantMessage,
      };
    });
    if (finalized.assistantMessage) {
      this.invalidateSessionMemory(baseCommitInput.sessionId);
    }
    if (!finalized.alreadyFinalized && !await this.cacheCommittedTaskRun({
      ...baseCommitInput,
      conversationRefs: finalized.assistantMessage
        ? includeConversationRecordInRefs(baseCommitInput.conversationRefs, finalized.assistantMessage)
        : baseCommitInput.conversationRefs,
      ...(finalized.result.sessionStoreCommit ? { sessionStoreCommit: finalized.result.sessionStoreCommit } : {}),
    }, finalized.result)) {
      this.invalidateSessionMemory(baseCommitInput.sessionId);
    }
    this.clearCommittedPendingTurn(baseCommitInput.sessionId, finalized.result.runId);

    return {
      ...finalized.result,
      alreadyFinalized: finalized.alreadyFinalized,
      ...(finalized.assistantMessage ? { assistantMessage: finalized.assistantMessage } : {}),
    };
  }

  async checkpointSession(input: CheckpointGitMemoryRuntimeSessionInput): Promise<GitMemorySessionCheckpoint> {
    const result = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "session_checkpointed",
      label: "checkpoint_session",
      createdAt: input.at,
    }, async () => {
      return await this.store.checkpointSession(input);
    });
    this.invalidateSessionMemory(input.sessionId);
    return result;
  }

  async buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack> {
    return buildGitMemoryContextPackFromMemoryState(
      await this.hydrateMemoryState(sessionId),
    );
  }

  async buildMemoryState(sessionId: GitMemorySessionId): Promise<GitContextMemoryState> {
    return await this.hydrateMemoryState(sessionId);
  }

  getSessionWrites(sessionId: GitMemorySessionId): GitMemoryWriteBatchSnapshot[] {
    return this.writeQueue.getSessionWrites(sessionId);
  }

  private sessionIdForAt(at: string): GitMemorySessionId {
    return createGitMemorySessionId(sessionDateForAt(at, this.timezone), this.agentId);
  }

  private async hydrateMemoryState(sessionId: GitMemorySessionId): Promise<GitContextMemoryState> {
    const state = await this.getOrHydrateCachedMemoryState(sessionId);
    const pendingTurn = this.pendingTurns.get(sessionId);
    return {
      ...state,
      pendingWrites: buildGitContextPendingWrites(this.writeQueue.getSessionWrites(sessionId)),
      ...(pendingTurn ? { pendingTurn: toPendingTurnContext(pendingTurn) } : {}),
    };
  }

  private async getOrHydrateCachedMemoryState(sessionId: GitMemorySessionId): Promise<GitContextMemoryState> {
    const cached = this.sessionMemoryCache.get(sessionId);
    if (cached) {
      return cached;
    }
    const state = await this.memoryStateHydrator.hydrate({ sessionId });
    this.sessionMemoryCache.set(sessionId, state);
    return state;
  }

  private updateCachedSessionConversation(
    state: GitContextMemoryState,
    record: GitMemoryConversationRecord,
  ): void {
    const nextState: GitContextMemoryState = {
      ...state,
      pendingWrites: [],
      session: {
        ...state.session,
        conversationTail: tail(
          [...state.session.conversationTail, record],
          DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationTailLimit,
        ),
        conversationMarkdownTail: markdownTail(
          appendGitMemoryConversationMarkdown(state.session.conversationMarkdownTail, record),
          DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit,
        ),
      },
    };
    this.sessionMemoryCache.set(state.session.sessionId, nextState);
  }

  private setPendingTurn(turn: PendingGitMemoryTurnEnvelope): void {
    this.pendingTurns.set(turn.sessionId, turn);
  }

  private ensureUnboundPendingTurn(
    sessionId: GitMemorySessionId,
    input: ApplyGitMemoryTaskRouteInput,
  ): PendingGitMemoryTurnEnvelope {
    const existing = this.pendingTurns.get(sessionId);
    if (existing && sameConversationRange(existing, input)) {
      return existing;
    }
    const created: PendingGitMemoryTurnEnvelope = {
      sessionId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      text: input.userMessage,
      at: input.at ?? this.nowProvider().toISOString(),
      routingStatus: "unbound",
    };
    this.setPendingTurn(created);
    return created;
  }

  private bindPendingTurn(
    sessionId: GitMemorySessionId,
    input: {
      fromSeq: number;
      toSeq: number;
      taskId: GitMemoryTaskId;
      branch: string;
      runId: GitMemoryRunId;
    },
  ): void {
    const existing = this.pendingTurns.get(sessionId);
    if (!existing || !sameConversationRange(existing, input)) {
      return;
    }
    this.pendingTurns.set(sessionId, {
      ...existing,
      routingStatus: "bound",
      taskId: input.taskId,
      branch: input.branch,
      runId: input.runId,
    });
  }

  private markPendingTurnClarifying(
    sessionId: GitMemorySessionId,
    input: {
      fromSeq: number;
      toSeq: number;
    },
  ): void {
    const existing = this.pendingTurns.get(sessionId);
    if (!existing || !sameConversationRange(existing, input)) {
      return;
    }
    this.pendingTurns.set(sessionId, {
      ...existing,
      routingStatus: "clarifying",
    });
  }

  private clearCommittedPendingTurn(sessionId: GitMemorySessionId, runId: GitMemoryRunId): void {
    const existing = this.pendingTurns.get(sessionId);
    if (existing?.runId === runId) {
      this.pendingTurns.delete(sessionId);
    }
  }

  private clearUnboundPendingTurn(sessionId: GitMemorySessionId): void {
    const existing = this.pendingTurns.get(sessionId);
    if (!existing || existing.routingStatus === "unbound") {
      this.pendingTurns.delete(sessionId);
    }
  }

  private async requireOrCreateUnboundPendingTurn(
    sessionId: GitMemorySessionId,
    at?: string,
  ): Promise<PendingGitMemoryTurnEnvelope> {
    const existing = this.pendingTurns.get(sessionId);
    if (existing) {
      if (existing.routingStatus !== "unbound") {
        throw new Error(`Git memory pending turn is not unbound: ${existing.routingStatus}`);
      }
      return existing;
    }
    const cachedState = await this.getOrHydrateCachedMemoryState(sessionId);
    const cachedLatestUserMessage = [...cachedState.session.conversationTail]
      .reverse()
      .find((record) => record.role === "user");
    const latestUserMessage = cachedLatestUserMessage ?? [...await this.store.readSessionConversationRecords(sessionId)]
      .reverse()
      .find((record) => record.role === "user");
    if (!latestUserMessage) {
      throw new Error(`Git memory pending turn not found for session: ${sessionId}`);
    }
    const created: PendingGitMemoryTurnEnvelope = {
      sessionId,
      fromSeq: latestUserMessage.seq,
      toSeq: latestUserMessage.seq,
      text: latestUserMessage.text ?? "",
      at: at ?? latestUserMessage.at,
      routingStatus: "unbound",
    };
    this.setPendingTurn(created);
    return created;
  }

  private async taskRouteCandidatesForIds(
    sessionId: GitMemorySessionId,
    taskIds: GitMemoryTaskId[],
    reason: string,
  ): Promise<GitMemoryTaskRouteCandidate[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const requested = new Set(taskIds);
    const snapshot = await this.store.readTaskRoutingSnapshot(sessionId);
    return snapshot.tasks
      .filter((task) => requested.has(task.taskId))
      .map((task) => ({
        taskId: task.taskId,
        branch: task.branch,
        ref: task.ref,
        title: task.title,
        status: task.status,
        score: 100,
        reasons: [reason],
      }));
  }

  private async cacheCreatedTask(
    input: CreateGitMemoryTaskBranchInput,
    result: CreateGitMemoryTaskBranchResult,
  ): Promise<void> {
    const state = await this.getOrHydrateCachedMemoryState(input.sessionId);
    const status = input.state?.status ?? input.status ?? "open";
    const summary = input.state?.summary ?? input.objective;
    const completed = input.state?.completed ?? [];
    const open = input.state?.open ?? [input.objective];
    const blockers = input.state?.blockers ?? [];
    const facts = input.state?.facts ?? [];
    const next = input.state?.next ?? input.objective;
    const conversation = conversationRecordsInRange(state.session.conversationTail, input);
    const activeTask: GitContextMemoryActiveTask = {
      taskId: result.taskId,
      branch: result.branch,
      ref: result.ref,
      title: input.title,
      objective: input.objective,
      status,
      summary,
      completed,
      open,
      blockers,
      facts,
      next,
      assets: [],
      conversationMarkdownTail: markdownTail(
        renderGitMemoryConversationMarkdownDocument(conversation, {
          taskId: result.taskId,
          ...(input.runId ? { runId: input.runId } : {}),
        }),
        DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit,
      ),
      recentRuns: [],
      recentCommits: [],
      recentEvidence: [],
    };
    const knownTask = {
      taskId: activeTask.taskId,
      branch: activeTask.branch,
      ref: activeTask.ref,
      title: activeTask.title,
      objective: activeTask.objective,
      status: activeTask.status,
      summary: activeTask.summary,
      open: activeTask.open,
      blockers: activeTask.blockers,
      facts: activeTask.facts,
      next: activeTask.next,
    };
    this.sessionMemoryCache.set(input.sessionId, {
      ...state,
      session: {
        ...state.session,
        taskCount: state.knownTasks.some((task) => task.taskId === result.taskId)
          ? state.session.taskCount
          : state.session.taskCount + 1,
        currentBranch: result.branch,
      },
      focus: {
        status: "active",
        taskId: result.taskId,
        branch: result.branch,
        ref: result.ref,
      },
      activeTask,
      knownTasks: [
        knownTask,
        ...state.knownTasks.filter((task) => task.taskId !== result.taskId),
      ],
    });
  }

  private updateCachedTaskConversation(
    sessionId: GitMemorySessionId,
    taskId: GitMemoryTaskId | undefined,
    record: GitMemoryConversationRecord,
  ): boolean {
    const state = this.sessionMemoryCache.get(sessionId);
    if (!state || !taskId || state.activeTask?.taskId !== taskId) {
      return false;
    }
    this.sessionMemoryCache.set(sessionId, {
      ...state,
      session: {
        ...state.session,
        conversationTail: tail(
          [...state.session.conversationTail, record],
          DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationTailLimit,
        ),
        conversationMarkdownTail: markdownTail(
          appendGitMemoryConversationMarkdown(state.session.conversationMarkdownTail, record),
          DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit,
        ),
      },
      activeTask: {
        ...state.activeTask,
        conversationMarkdownTail: markdownTail(
          appendGitMemoryConversationMarkdown(state.activeTask.conversationMarkdownTail, record),
          DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit,
        ),
      },
    });
    return true;
  }

  private async cacheRoutedTaskTurn(
    input: ApplyGitMemoryTaskRouteInput,
    routed: Extract<AppliedGitMemoryTaskRoute, { status: "ready" }> & { runId: GitMemoryRunId },
  ): Promise<boolean> {
    if (routed.createdTask) {
      await this.cacheCreatedTask({
        sessionId: input.sessionId,
        title: routed.createdTask.title,
        objective: routed.createdTask.objective,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        runId: routed.runId,
        at: input.at,
        status: routed.createdTask.status,
        state: routed.createdTask.state,
      }, routed.createdTask);
      return true;
    }

    const state = this.sessionMemoryCache.get(input.sessionId);
    if (!state?.activeTask || state.activeTask.taskId !== routed.taskId) {
      return false;
    }

    const conversation = conversationRecordsInRange(state.session.conversationTail, input);
    const activeTask: GitContextMemoryActiveTask = {
      ...state.activeTask,
      branch: routed.branch,
      ref: routed.ref,
      conversationMarkdownTail: markdownTail(
        appendGitMemoryConversationMarkdownRecords(state.activeTask.conversationMarkdownTail, conversation, {
          taskId: routed.taskId,
          runId: routed.runId,
        }),
        DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.conversationMarkdownCharLimit,
      ),
    };
    this.sessionMemoryCache.set(input.sessionId, {
      ...state,
      session: {
        ...state.session,
        currentBranch: routed.branch,
      },
      focus: {
        status: "active",
        taskId: routed.taskId,
        branch: routed.branch,
        ref: routed.ref,
      },
      activeTask,
      knownTasks: state.knownTasks.map((task) => task.taskId === routed.taskId
        ? {
          ...task,
          branch: routed.branch,
          ref: routed.ref,
        }
        : task),
    });
    return true;
  }

  private async cacheCommittedTaskRun(
    input: CommitGitMemoryTaskRunInput,
    result: CommitGitMemoryTaskRunResult,
  ): Promise<boolean> {
    const state = this.sessionMemoryCache.get(input.sessionId);
    if (!state?.activeTask || state.activeTask.taskId !== result.taskId) {
      return false;
    }
    const completedAt = input.completedAt ?? this.nowProvider().toISOString();
    const startedAt = input.startedAt ?? completedAt;
    const previous = state.activeTask;
    const newFacts = input.newFacts ?? [];
    const facts = input.state?.facts ?? unique([...previous.facts, ...newFacts]);
    const updatedTask: GitContextMemoryActiveTask = {
      ...previous,
      status: input.state?.status ?? previous.status,
      summary: input.state?.summary ?? input.summary,
      completed: input.state?.completed ?? previous.completed,
      open: input.state?.open ?? previous.open,
      blockers: input.state?.blockers ?? previous.blockers,
      facts,
      next: input.state?.next ?? input.next ?? previous.next,
      assets: mergeCachedAssets(previous.assets, input.assets ?? []),
      recentRuns: [
        buildCachedRunFile(input, result.runId, startedAt, completedAt),
        ...previous.recentRuns.filter((run) => run.runId !== result.runId),
      ].slice(0, DEFAULT_GIT_MEMORY_CONTEXT_LIMITS.runLimit),
    };
    this.sessionMemoryCache.set(input.sessionId, {
      ...state,
      session: {
        ...state.session,
        currentBranch: result.branch,
      },
      focus: {
        status: "active",
        taskId: result.taskId,
        branch: result.branch,
        ref: result.ref,
      },
      activeTask: updatedTask,
      knownTasks: state.knownTasks.map((task) => task.taskId === result.taskId
        ? {
          ...task,
          status: updatedTask.status,
          summary: updatedTask.summary,
          open: updatedTask.open,
          blockers: updatedTask.blockers,
          facts: updatedTask.facts,
          next: updatedTask.next,
        }
        : task),
    });
    return true;
  }

  private async createAndCacheConversationRecord(
    sessionId: GitMemorySessionId,
	    input: {
	      role: GitMemoryConversationRole;
	      kind?: GitMemoryConversationRecord["kind"];
	      text: string;
      at: string;
    },
  ): Promise<GitMemoryConversationRecord> {
    const hydrated = await this.getOrHydrateCachedMemoryState(sessionId);
    const latest = this.sessionMemoryCache.get(sessionId) ?? hydrated;
    const record = this.createCachedConversationRecord(latest, input);
    this.updateCachedSessionConversation(latest, record);
    return record;
  }

  private createCachedConversationRecord(
    state: GitContextMemoryState,
	    input: {
	      role: GitMemoryConversationRole;
	      kind?: GitMemoryConversationRecord["kind"];
	      text: string;
      at: string;
    },
  ): GitMemoryConversationRecord {
    return {
	      seq: nextConversationSeq(state.session.conversationTail),
	      role: input.role,
	      ...(input.kind ? { kind: input.kind } : {}),
	      at: input.at,
      text: input.text,
    };
  }

  private enqueueGlobalConversationPersistence(input: {
    sessionId: GitMemorySessionId;
    type: GitMemoryWriteBatchRequest["type"];
    label: string;
    createdAt: string;
    record: GitMemoryConversationRecord;
  }): void {
    const persistence = this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: input.type,
      label: input.label,
      createdAt: input.createdAt,
    }, async () => {
      await this.store.appendMainConversationRecord({
        sessionId: input.sessionId,
        record: input.record,
      });
    });
    void persistence.catch(() => undefined);
  }

  private invalidateSessionMemory(sessionId: GitMemorySessionId): void {
    this.sessionMemoryCache.delete(sessionId);
  }
}

export function createGitMemoryRuntime(options: GitMemoryRuntimeOptions): GitMemoryRuntime {
  return new GitMemoryRuntime(options);
}

export function sessionDateForAt(at: string, timezone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid git-memory runtime timestamp: ${at}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  return `${year}-${month}-${day}`;
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Could not resolve ${type} for git-memory runtime date.`);
  }
  return value;
}

function tail<T>(items: T[], limit: number): T[] {
  return items.slice(Math.max(0, items.length - limit));
}

function markdownTail(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(value.length - limit);
}

function nextConversationSeq(records: Array<{ seq?: unknown }>): number {
  return records.reduce((max, record) => (
    typeof record.seq === "number" && Number.isInteger(record.seq) ? Math.max(max, record.seq) : max
  ), 0) + 1;
}

function conversationRecordsInRange(
  records: GitMemoryConversationRecord[],
  range: { fromSeq: number; toSeq: number },
): GitMemoryConversationRecord[] {
  return records.filter((record) => record.seq >= range.fromSeq && record.seq <= range.toSeq);
}

function includeConversationRecordInRefs(
  refs: GitMemoryConversationSeqRange[],
  record: GitMemoryConversationRecord,
): GitMemoryConversationSeqRange[] {
  if (refs.length === 0) {
    return [{ fromSeq: record.seq, toSeq: record.seq }];
  }
  const next = refs.map((ref) => ({ ...ref }));
  const containing = next.find((ref) => record.seq >= ref.fromSeq && record.seq <= ref.toSeq);
  if (containing) {
    return next;
  }
  const last = next[next.length - 1]!;
  if (record.seq >= last.fromSeq) {
    last.toSeq = Math.max(last.toSeq, record.seq);
    return next;
  }
  next.push({ fromSeq: record.seq, toSeq: record.seq });
  return next.sort((left, right) => left.fromSeq - right.fromSeq);
}

function sameConversationRange(
  left: { fromSeq: number; toSeq: number },
  right: { fromSeq: number; toSeq: number },
): boolean {
  return left.fromSeq === right.fromSeq && left.toSeq === right.toSeq;
}

function isReopenTaskStatus(status: string): boolean {
  return status === "done" || status === "abandoned";
}

function toPendingTurnContext(turn: PendingGitMemoryTurnEnvelope): GitMemoryPendingTurnContext {
  return {
    fromSeq: turn.fromSeq,
    toSeq: turn.toSeq,
    text: turn.text,
    at: turn.at,
    routingStatus: turn.routingStatus,
    ...(turn.taskId ? { taskId: turn.taskId } : {}),
    ...(turn.branch ? { branch: turn.branch } : {}),
    ...(turn.runId ? { runId: turn.runId } : {}),
  };
}

function buildCachedRunFile(
  input: CommitGitMemoryTaskRunInput,
  runId: GitMemoryRunId,
  startedAt: string,
  completedAt: string,
): GitMemoryRunFile {
  return {
    schemaVersion: 1,
    runId,
    taskId: input.taskId,
    status: input.status,
    startedAt,
    completedAt,
    conversationRefs: input.conversationRefs,
    ...(input.sessionStoreCommit ? { sessionStoreCommit: input.sessionStoreCommit } : {}),
    summary: input.summary,
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.routing ? { routing: input.routing } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.workPerformed?.length ? { workPerformed: input.workPerformed } : {}),
    ...(input.verification?.length ? { verification: input.verification } : {}),
    ...(input.decisions?.length ? { decisions: input.decisions } : {}),
    ...(input.blockers?.length ? { blockers: input.blockers } : {}),
    ...(input.assistantResponse ? { assistantResponse: input.assistantResponse } : {}),
    toolCallCount: input.toolCallCount ?? input.actions?.length ?? 0,
    changedFiles: input.changedFiles ?? [],
    newFacts: input.newFacts ?? [],
    ...(input.next ? { next: input.next } : {}),
  };
}

function mergeCachedAssets(
  existing: TaskAssetRecord[],
  incoming: TaskAssetRecord[],
): TaskAssetRecord[] {
  const byId = new Map(existing.map((asset) => [asset.assetId, asset]));
  for (const asset of incoming) {
    byId.set(asset.assetId, asset);
  }
  return [...byId.values()];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
