import type {
  GitMemoryConversationRecord,
  GitMemoryMachineContextPack,
  GitMemoryRunId,
  GitMemoryRuntime,
  GitMemorySessionId,
  GitMemoryTaskId,
  GitMemoryTurnId,
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

export interface GitMemoryChatContextRuntime {
  prepareUserTurn(input: ChatContextRuntimePrepareInput): Promise<GitMemoryChatContextPreparedTurn>;
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
