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

export type RoutedGitMemoryUserTurn = AppliedGitMemoryTaskRoute & {
  context: GitMemoryMachineContextPack;
};

export class GitMemoryRuntime {
  private readonly timezone: string;
  private readonly agentId: string;
  private readonly nowProvider: () => Date;
  private readonly store: GitMemoryDailySessionStore;
  private readonly contextReader: GitMemoryContextReader;
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
    return {
      status: "ready",
      sessionId: session.sessionId,
      repoPath: session.repoPath,
      initialized: session.initialized,
      userMessage,
      context: await this.contextReader.buildActiveContext({ sessionId: session.sessionId }),
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
    const route = await this.taskRouter.route(input);
    return {
      ...route,
      context: await this.contextReader.buildActiveContext({ sessionId: input.sessionId }),
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
