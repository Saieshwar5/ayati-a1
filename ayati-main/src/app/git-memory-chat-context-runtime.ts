import type {
  CommitGitMemoryTaskRunResult,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
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
  buildGitMemoryTaskRunCommitInput,
} from "../context-engine/index.js";
import type {
  ChatContextRuntimePrepareInput,
} from "../ivec/chat-context-runtime.js";
import { devWarn } from "../shared/index.js";

export interface CreateGitMemoryChatContextRuntimeOptions {
  gitMemoryRuntime: GitMemoryRuntime;
}

export interface GitMemoryChatContextPreparedTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  messageId: string;
  turnId: GitMemoryTurnId;
  context: GitMemoryMachineContextPack;
}

export interface GitMemoryChatContextAssistantMessageInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  message: string;
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface GitMemoryChatContextCompleteTaskRunInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  result: GitMemoryHarnessRunResultForContext;
  at: string;
  startedAt?: string;
  conversationRefs?: GitMemoryConversationSeqRange[];
  changedFiles?: string[];
}

export interface GitMemoryChatContextRouteTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  userMessage: string;
  at: string;
  title?: string;
  objective?: string;
}

export interface GitMemoryChatContextRuntime {
  prepareUserTurn(input: ChatContextRuntimePrepareInput): Promise<GitMemoryChatContextPreparedTurn>;
  routeTaskTurn(input: GitMemoryChatContextRouteTaskTurnInput): Promise<RoutedGitMemoryUserTurn | null>;
  completeTaskRun(input: GitMemoryChatContextCompleteTaskRunInput): Promise<CommitGitMemoryTaskRunResult | null>;
  recordAssistantMessage(input: GitMemoryChatContextAssistantMessageInput): Promise<GitMemoryConversationRecord | null>;
  buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack>;
}

export function createGitMemoryChatContextRuntime(
  options: CreateGitMemoryChatContextRuntimeOptions,
): GitMemoryChatContextRuntime {
  return new AppGitMemoryChatContextRuntime(options.gitMemoryRuntime);
}

class AppGitMemoryChatContextRuntime implements GitMemoryChatContextRuntime {
  constructor(private readonly gitMemoryRuntime: GitMemoryRuntime) {}

  async prepareUserTurn(input: ChatContextRuntimePrepareInput): Promise<GitMemoryChatContextPreparedTurn> {
    const prepared = await this.gitMemoryRuntime.prepareUserTurn({
      userMessage: input.userMessage,
      at: input.at,
    });
    return {
      status: "ready",
      sessionId: prepared.sessionId,
      repoPath: prepared.repoPath,
      initialized: prepared.initialized,
      messageSeq: prepared.userMessage.seq,
      messageId: prepared.userMessage.messageId,
      turnId: prepared.userMessage.turnId,
      context: prepared.context,
    };
  }

  async routeTaskTurn(
    input: GitMemoryChatContextRouteTaskTurnInput,
  ): Promise<RoutedGitMemoryUserTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.routeUserTurn({
        sessionId: input.turn.sessionId,
        userMessage: input.userMessage,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        turnIds: [input.turn.turnId],
        title: input.title,
        objective: input.objective,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory task routing failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async completeTaskRun(
    input: GitMemoryChatContextCompleteTaskRunInput,
  ): Promise<CommitGitMemoryTaskRunResult | null> {
    if (!input.turn) {
      return null;
    }
    try {
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
    } catch (err) {
      devWarn(`[${input.clientId}] git memory task run commit failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async recordAssistantMessage(
    input: GitMemoryChatContextAssistantMessageInput,
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
      devWarn(`[${input.clientId}] git memory assistant conversation write failed: ${errorMessage(err)}`);
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
