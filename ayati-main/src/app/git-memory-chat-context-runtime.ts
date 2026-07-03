import type {
  FinalizeGitMemoryTaskRunResult,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
  GitContextMemoryState,
  GitMemoryHarnessRunResultForContext,
  GitMemoryMachineContextPack,
  GitMemoryRunId,
  GitMemorySessionAttachmentRecord,
  GitMemorySessionAttachmentsFile,
  GitMemoryRuntime,
  GitMemorySessionId,
  GitMemoryTaskId,
  RoutedGitMemoryUserTurn,
} from "../context-engine/index.js";
import {
  buildGitMemoryHarnessContextFromMemoryState,
} from "../context-engine/index.js";
import type { HarnessContextInput } from "../ivec/harness-context.js";
import { devWarn } from "../shared/index.js";

export interface CreateGitMemoryChatContextRuntimeOptions {
  gitMemoryRuntime: GitMemoryRuntime;
}

export interface GitMemoryChatContextPrepareInput {
  clientId: string;
  userMessage: string;
  at: string;
}

export interface GitMemoryChatContextPreparedTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface GitMemoryChatContextAssistantMessageInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  message: string;
  kind?: GitMemoryConversationRecord["kind"];
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface GitMemoryChatContextSessionAttachmentsInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  attachments: GitMemorySessionAttachmentRecord[];
  at: string;
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
  assistantMessage?: string;
  assistantMessageKind?: GitMemoryConversationRecord["kind"];
  assistantAt?: string;
}

export interface GitMemoryChatContextRouteTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  userMessage: string;
  at: string;
  title?: string;
  objective?: string;
  autoOnly?: boolean;
}

export interface GitMemoryChatContextActivateTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  reason: string;
  at: string;
}

export type GitMemoryChatContextRoutedTurn = RoutedGitMemoryUserTurn & {
  harnessContext: HarnessContextInput;
};

export interface GitMemoryChatContextRuntime {
  prepareUserTurn(input: GitMemoryChatContextPrepareInput): Promise<GitMemoryChatContextPreparedTurn>;
  routeTaskTurn(input: GitMemoryChatContextRouteTaskTurnInput): Promise<GitMemoryChatContextRoutedTurn | null>;
  activateTaskTurn(input: GitMemoryChatContextActivateTaskTurnInput): Promise<GitMemoryChatContextRoutedTurn | null>;
  completeTaskRun(input: GitMemoryChatContextCompleteTaskRunInput): Promise<FinalizeGitMemoryTaskRunResult | null>;
  recordAssistantMessage(input: GitMemoryChatContextAssistantMessageInput): Promise<GitMemoryConversationRecord | null>;
  recordSessionAttachments(input: GitMemoryChatContextSessionAttachmentsInput): Promise<GitMemorySessionAttachmentsFile | null>;
  buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack>;
}

export function createGitMemoryChatContextRuntime(
  options: CreateGitMemoryChatContextRuntimeOptions,
): GitMemoryChatContextRuntime {
  return new AppGitMemoryChatContextRuntime(options.gitMemoryRuntime);
}

class AppGitMemoryChatContextRuntime implements GitMemoryChatContextRuntime {
  constructor(private readonly gitMemoryRuntime: GitMemoryRuntime) {}

  async prepareUserTurn(input: GitMemoryChatContextPrepareInput): Promise<GitMemoryChatContextPreparedTurn> {
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
      context: prepared.context,
      memoryState: prepared.memoryState,
    };
  }

  async routeTaskTurn(
    input: GitMemoryChatContextRouteTaskTurnInput,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const routeInput = {
        sessionId: input.turn.sessionId,
        userMessage: input.userMessage,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        title: input.title,
        objective: input.objective,
      };
      const route = await this.gitMemoryRuntime.continueActiveTurn(routeInput)
        ?? (input.autoOnly ? null : await this.gitMemoryRuntime.routeUserTurn(routeInput));
      if (!route) {
        return null;
      }
      return {
        ...route,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(route.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory task routing failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async activateTaskTurn(
    input: GitMemoryChatContextActivateTaskTurnInput,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const routed = await this.gitMemoryRuntime.activateTaskForTurn({
        sessionId: input.turn.sessionId,
        taskId: input.taskId,
        reason: input.reason,
        at: input.at,
      });
      return {
        ...routed,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(routed.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory active task binding failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async completeTaskRun(
    input: GitMemoryChatContextCompleteTaskRunInput,
  ): Promise<FinalizeGitMemoryTaskRunResult | null> {
    if (!input.turn) {
      return null;
    }
    return await this.gitMemoryRuntime.finalizeTaskRun({
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
      assistantMessage: input.assistantMessage,
      assistantMessageKind: input.assistantMessageKind,
      assistantAt: input.assistantAt,
    });
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
        text: input.message,
        kind: input.kind,
        at: input.at,
        taskId: input.taskId,
        runId: input.runId,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory assistant conversation write failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async recordSessionAttachments(
    input: GitMemoryChatContextSessionAttachmentsInput,
  ): Promise<GitMemorySessionAttachmentsFile | null> {
    if (!input.turn || input.attachments.length === 0) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.recordSessionAttachments({
        sessionId: input.turn.sessionId,
        attachments: input.attachments,
        at: input.at,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory session attachment write failed: ${errorMessage(err)}`);
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
