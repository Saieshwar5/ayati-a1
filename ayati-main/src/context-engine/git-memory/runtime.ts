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
import { GitMemoryContextReader, type GitMemoryMachineContextPack } from "./context-pack.js";
import { GitContextMemoryStateHydrator, type GitContextMemoryState } from "./memory-state.js";
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
  GitMemoryTurnId,
} from "./schema.js";

export interface GitMemoryRuntimeOptions {
  contextStoreDir: string;
  timezone: string;
  agentId: string;
  now?: () => Date;
  store?: GitMemoryDailySessionStore;
  contextReader?: GitMemoryContextReader;
  taskRouter?: GitMemoryTaskRouter;
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
  turnId?: GitMemoryTurnId;
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
  private readonly contextReader: GitMemoryContextReader;
  private readonly memoryStateHydrator: GitContextMemoryStateHydrator;
  private readonly taskRouter: GitMemoryTaskRouter;

  constructor(options: GitMemoryRuntimeOptions) {
    this.timezone = options.timezone;
    this.agentId = options.agentId;
    this.nowProvider = options.now ?? (() => new Date());
    this.store = options.store ?? new GitMemoryDailySessionStore({
      contextStoreDir: options.contextStoreDir,
      now: this.nowProvider,
    });
    this.contextReader = options.contextReader ?? new GitMemoryContextReader(this.store);
    this.memoryStateHydrator = new GitContextMemoryStateHydrator(this.store);
    this.taskRouter = options.taskRouter ?? new GitMemoryTaskRouter(this.store);
  }

  async openDailySession(input: OpenGitMemoryRuntimeSessionInput = {}): Promise<GitMemoryDailySessionHandle> {
    const at = input.at ?? this.nowProvider().toISOString();
    return await this.store.openOrCreateDailySession({
      date: sessionDateForAt(at, this.timezone),
      timezone: this.timezone,
      agentId: this.agentId,
      createdAt: at,
    });
  }

  async prepareUserTurn(input: PrepareGitMemoryUserTurnInput): Promise<PreparedGitMemoryUserTurn> {
    const at = input.at ?? this.nowProvider().toISOString();
    const session = await this.openDailySession({ at });
    const userMessage = await this.store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: input.userMessage,
      at,
    });
    const [context, memoryState] = await Promise.all([
      this.contextReader.buildActiveContext({ sessionId: session.sessionId }),
      this.memoryStateHydrator.hydrate({ sessionId: session.sessionId }),
    ]);
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
    const session = await this.openDailySession({ at });
    const systemMessage = await this.store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "system",
      text: input.systemMessage,
      at,
    });
    const [context, memoryState] = await Promise.all([
      this.contextReader.buildActiveContext({ sessionId: session.sessionId }),
      this.memoryStateHydrator.hydrate({ sessionId: session.sessionId }),
    ]);
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
    return await this.store.appendConversationMessage({
      sessionId: input.sessionId,
      role: "assistant",
      text: input.text,
      at: input.at,
      turnId: input.turnId,
      taskId: input.taskId,
      runId: input.runId,
    });
  }

  async createTaskBranch(input: CreateGitMemoryTaskBranchInput): Promise<CreateGitMemoryTaskBranchResult> {
    return await this.store.createTaskBranch(input);
  }

  async readTaskRoutingSnapshot(sessionId: GitMemorySessionId): Promise<GitMemoryTaskRoutingSnapshot> {
    return await this.store.readTaskRoutingSnapshot(sessionId);
  }

  async resolveTaskRoute(input: ResolveGitMemoryTaskRouteInput): Promise<GitMemoryTaskRouteResolution> {
    return await this.taskRouter.resolve(input);
  }

  async routeUserTurn(input: ApplyGitMemoryTaskRouteInput): Promise<RoutedGitMemoryUserTurn> {
    const runId = await this.store.allocateTaskRunId(input.sessionId);
    const route = await this.taskRouter.route({ ...input, runId });
    if (route.status === "ambiguous") {
      const [context, memoryState] = await Promise.all([
        this.contextReader.buildActiveContext({ sessionId: input.sessionId }),
        this.memoryStateHydrator.hydrate({ sessionId: input.sessionId }),
      ]);
      return {
        ...route,
        context,
        memoryState,
      };
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
    const [context, memoryState] = await Promise.all([
      this.contextReader.buildActiveContext({ sessionId: input.sessionId }),
      this.memoryStateHydrator.hydrate({ sessionId: input.sessionId }),
    ]);
    return {
      ...route,
      runId,
      context,
      memoryState,
    };
  }

  async commitTaskRun(input: CommitGitMemoryTaskRunInput): Promise<CommitGitMemoryTaskRunResult> {
    return await this.store.commitTaskRun(input);
  }

  async checkpointSession(input: CheckpointGitMemoryRuntimeSessionInput): Promise<GitMemorySessionCheckpoint> {
    return await this.store.checkpointSession(input);
  }

  async buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack> {
    return await this.contextReader.buildActiveContext({ sessionId });
  }

  async buildMemoryState(sessionId: GitMemorySessionId): Promise<GitContextMemoryState> {
    return await this.memoryStateHydrator.hydrate({ sessionId });
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
