import type {
  CommitGitMemoryTaskRunResult,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
  GitContextMemoryState,
  GitMemoryHarnessRunResultForContext,
  GitMemoryMachineContextPack,
  GitMemoryRunId,
  GitMemoryRuntime,
  GitMemorySessionId,
  GitMemoryTaskId,
  GitMemoryTurnId,
  RoutedGitMemoryUserTurn,
} from "../context-engine/index.js";
import {
  buildGitMemoryHarnessContextFromMemoryState,
  buildGitMemoryTaskRunCommitInput,
} from "../context-engine/index.js";
import type { HarnessContextInput } from "../ivec/harness-context.js";
import { devWarn } from "../shared/index.js";

export interface CreateGitMemorySystemEventContextRuntimeOptions {
  gitMemoryRuntime: GitMemoryRuntime;
}

export interface GitMemorySystemEventContextPrepareInput {
  clientId: string;
  systemMessage: string;
  at: string;
}

export interface GitMemorySystemEventContextPreparedTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  messageId: string;
  turnId: GitMemoryTurnId;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface GitMemorySystemEventContextAssistantMessageInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  message: string;
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface GitMemorySystemEventContextCompleteTaskRunInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  result: GitMemoryHarnessRunResultForContext;
  at: string;
  startedAt?: string;
  conversationRefs?: GitMemoryConversationSeqRange[];
  changedFiles?: string[];
}

export interface GitMemorySystemEventContextRouteTaskTurnInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  userMessage: string;
  at: string;
  title?: string;
  objective?: string;
}

export type GitMemorySystemEventContextRoutedTurn = RoutedGitMemoryUserTurn & {
  harnessContext: HarnessContextInput;
};

export interface GitMemorySystemEventContextRuntime {
  prepareSystemEventTurn(
    input: GitMemorySystemEventContextPrepareInput,
  ): Promise<GitMemorySystemEventContextPreparedTurn>;
  routeTaskTurn(
    input: GitMemorySystemEventContextRouteTaskTurnInput,
  ): Promise<GitMemorySystemEventContextRoutedTurn | null>;
  completeTaskRun(input: GitMemorySystemEventContextCompleteTaskRunInput): Promise<CommitGitMemoryTaskRunResult | null>;
  recordAssistantMessage(
    input: GitMemorySystemEventContextAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord | null>;
  buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack>;
}

export function createGitMemorySystemEventContextRuntime(
  options: CreateGitMemorySystemEventContextRuntimeOptions,
): GitMemorySystemEventContextRuntime {
  return new AppGitMemorySystemEventContextRuntime(options.gitMemoryRuntime);
}

class AppGitMemorySystemEventContextRuntime implements GitMemorySystemEventContextRuntime {
  constructor(private readonly gitMemoryRuntime: GitMemoryRuntime) {}

  async prepareSystemEventTurn(
    input: GitMemorySystemEventContextPrepareInput,
  ): Promise<GitMemorySystemEventContextPreparedTurn> {
    const prepared = await this.gitMemoryRuntime.prepareSystemTurn({
      systemMessage: input.systemMessage,
      at: input.at,
    });
    if (!prepared.systemMessage.messageId) {
      throw new Error("Git memory prepared system message is missing messageId");
    }
    if (!prepared.systemMessage.turnId) {
      throw new Error("Git memory prepared system message is missing turnId");
    }
    const messageId = prepared.systemMessage.messageId;
    const turnId = prepared.systemMessage.turnId;
    return {
      status: "ready",
      sessionId: prepared.sessionId,
      repoPath: prepared.repoPath,
      initialized: prepared.initialized,
      messageSeq: prepared.systemMessage.seq,
      messageId,
      turnId,
      context: prepared.context,
      memoryState: prepared.memoryState,
    };
  }

  async routeTaskTurn(
    input: GitMemorySystemEventContextRouteTaskTurnInput,
  ): Promise<GitMemorySystemEventContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const route = await this.gitMemoryRuntime.routeUserTurn({
        sessionId: input.turn.sessionId,
        userMessage: input.userMessage,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        turnIds: [input.turn.turnId],
        title: input.title,
        objective: input.objective,
      });
      return {
        ...route,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(route.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event task routing failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async completeTaskRun(
    input: GitMemorySystemEventContextCompleteTaskRunInput,
  ): Promise<CommitGitMemoryTaskRunResult | null> {
    if (!input.turn) {
      return null;
    }
    return await this.gitMemoryRuntime.commitTaskRun(buildGitMemoryTaskRunCommitInput({
      sessionId: input.turn.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      result: input.result,
      conversationRefs: input.conversationRefs ?? [{
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
      }],
      at: input.at,
      startedAt: input.startedAt,
      changedFiles: input.changedFiles,
    }));
  }

  async recordAssistantMessage(
    input: GitMemorySystemEventContextAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.recordAssistantMessage({
        sessionId: input.turn.sessionId,
        turnId: input.turn.turnId,
        text: input.message,
        at: input.at,
        taskId: input.taskId,
        runId: input.runId,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event assistant conversation write failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack> {
    return await this.gitMemoryRuntime.buildActiveContext(sessionId);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
