import type {
  CommitGitMemoryTaskRunInput,
  CommitGitMemoryTaskRunResult,
  CreateGitMemoryTaskBranchInput,
  CreateGitMemoryTaskBranchResult,
  GitMemoryDailySessionHandle,
  GitMemorySessionCheckpoint,
  GitMemoryTaskRoutingSnapshot,
} from "./session-store.js";
import { GitMemoryDailySessionStore } from "./session-store.js";
import {
  DEFAULT_GIT_MEMORY_CONTEXT_LIMITS,
  type GitMemoryMachineContextPack,
} from "./context-pack.js";
import { appendGitMemoryConversationMarkdown } from "./conversation-markdown.js";
import {
  buildGitMemoryContextPackFromMemoryState,
  buildGitContextPendingWrites,
  GitContextMemoryStateHydrator,
  type GitContextMemoryState,
} from "./memory-state.js";
import {
  GitMemoryTaskRouter,
  type AppliedGitMemoryTaskRoute,
  type ApplyGitMemoryTaskRouteInput,
  type GitMemoryTaskRouteResolution,
  type ResolveGitMemoryTaskRouteInput,
} from "./task-router.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunId,
  GitMemorySessionId,
  GitMemoryTaskId,
} from "./schema.js";
import { createGitMemorySessionId } from "./schema.js";
import {
  GitMemoryWriteQueue,
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

export interface RecordGitMemoryAssistantMessageInput {
  sessionId: GitMemorySessionId;
  text: string;
  at?: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface CheckpointGitMemoryRuntimeSessionInput {
  sessionId: GitMemorySessionId;
  summary?: string;
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
    const prepared = await this.writeQueue.enqueue({
      sessionId,
      type: "main_conversation_appended",
      label: "prepare_user_turn",
      createdAt: at,
    }, async () => {
      const session = await this.openDailySessionUnqueued(at);
      const cachedState = await this.getOrHydrateCachedMemoryState(session.sessionId);
      const userMessage = await this.store.appendMainConversationMessage({
        sessionId: session.sessionId,
        role: "user",
        text: input.userMessage,
        at,
      });
      this.updateCachedSessionConversation(cachedState, userMessage);
      return {
        sessionId: session.sessionId,
        repoPath: session.repoPath,
        initialized: session.initialized,
        userMessage,
      };
    });
    const memoryState = await this.hydrateMemoryState(prepared.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      status: "ready",
      ...prepared,
      context,
      memoryState,
    };
  }

  async prepareSystemTurn(input: PrepareGitMemorySystemTurnInput): Promise<PreparedGitMemorySystemTurn> {
    const at = input.at ?? this.nowProvider().toISOString();
    const sessionId = this.sessionIdForAt(at);
    const prepared = await this.writeQueue.enqueue({
      sessionId,
      type: "main_conversation_appended",
      label: "prepare_system_turn",
      createdAt: at,
    }, async () => {
      const session = await this.openDailySessionUnqueued(at);
      const cachedState = await this.getOrHydrateCachedMemoryState(session.sessionId);
      const systemMessage = await this.store.appendMainConversationMessage({
        sessionId: session.sessionId,
        role: "system",
        text: input.systemMessage,
        at,
      });
      this.updateCachedSessionConversation(cachedState, systemMessage);
      return {
        sessionId: session.sessionId,
        repoPath: session.repoPath,
        initialized: session.initialized,
        systemMessage,
      };
    });
    const memoryState = await this.hydrateMemoryState(prepared.sessionId);
    const context = buildGitMemoryContextPackFromMemoryState(memoryState);
    return {
      status: "ready",
      ...prepared,
      context,
      memoryState,
    };
  }

  async recordAssistantMessage(
    input: RecordGitMemoryAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord> {
    const record = await this.writeQueue.enqueue({
      sessionId: input.sessionId,
      type: "assistant_message_recorded",
      label: "record_assistant_message",
      createdAt: input.at,
    }, async () => {
      const record = await this.store.appendConversationMessage({
        sessionId: input.sessionId,
        role: "assistant",
        text: input.text,
        at: input.at,
        taskId: input.taskId,
        runId: input.runId,
      });
      if (input.taskId) {
        await this.store.appendTaskConversationMessage({
          sessionId: input.sessionId,
          taskId: input.taskId,
          record,
          at: input.at,
        });
      }
      return record;
    });
    this.invalidateSessionMemory(input.sessionId);
    return record;
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
    this.invalidateSessionMemory(input.sessionId);
    return result;
  }

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    return await this.store.readTaskRoutingSnapshot(sessionId);
  }

  async resolveTaskRoute(input: ResolveGitMemoryTaskRouteInput): Promise<GitMemoryTaskRouteResolution> {
    return await this.taskRouter.resolve(input);
  }

  async routeUserTurn(input: ApplyGitMemoryTaskRouteInput): Promise<RoutedGitMemoryUserTurn> {
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
      if (!route.createdTask) {
        await this.store.appendTaskConversationRange({
          sessionId: input.sessionId,
          taskId: route.taskId,
          branch: route.branch,
          runId,
          fromSeq: input.fromSeq,
          toSeq: input.toSeq,
          at: input.at,
          reason: "task_routed",
        });
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
    this.invalidateSessionMemory(input.sessionId);
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
    this.invalidateSessionMemory(input.sessionId);
    return result;
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
    return {
      ...state,
      pendingWrites: buildGitContextPendingWrites(this.writeQueue.getSessionWrites(sessionId)),
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
