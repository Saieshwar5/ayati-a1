import {
  buildContextEngineRunCommitInput,
  type ContextEnginePreparedTurn,
  type ContextEngineRuntime,
} from "../context-engine/index.js";
import type {
  ChatContextAmbiguousTurn,
  ChatContextCommittedRun,
  ChatContextPreparedTurn,
  ChatContextReadyTurn,
  ChatContextRuntime,
  ChatContextRuntimeAssistantMessageInput,
  ChatContextRuntimeCompleteInput,
  ChatContextRuntimePrepareInput,
} from "../ivec/chat-context-runtime.js";
import { devWarn } from "../shared/index.js";

export interface CreateChatContextRuntimeOptions {
  contextEngineRuntime: ContextEngineRuntime;
}

export function createChatContextRuntime(
  options: CreateChatContextRuntimeOptions,
): ChatContextRuntime {
  return new ContextEngineChatContextRuntime(options.contextEngineRuntime);
}

class ContextEngineChatContextRuntime implements ChatContextRuntime {
  constructor(private readonly contextEngineRuntime: ContextEngineRuntime) {}

  async prepareUserTurn(input: ChatContextRuntimePrepareInput): Promise<ChatContextPreparedTurn> {
    const turn = await this.contextEngineRuntime.prepareUserTurn({
      userMessage: input.userMessage,
      at: input.at,
    });
    return toChatContextPreparedTurn(turn);
  }

  async completePreparedRun(input: ChatContextRuntimeCompleteInput): Promise<ChatContextCommittedRun | null> {
    try {
      const completed = await this.contextEngineRuntime.completePreparedRun(buildContextEngineRunCommitInput({
        sessionId: input.turn.sessionId,
        workId: input.turn.workId,
        runId: input.turn.runId,
        result: input.result,
        at: input.at,
      }));
      return {
        workId: input.turn.workId,
        workCommit: completed.run.workCommit,
        runRef: completed.run.runRef,
      };
    } catch (err) {
      devWarn(`[${input.clientId}] context engine write-back failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async recordAssistantMessage(input: ChatContextRuntimeAssistantMessageInput): Promise<void> {
    if (!input.turn) {
      return;
    }
    try {
      await this.contextEngineRuntime.recordAssistantMessage({
        sessionId: input.turn.sessionId,
        text: input.message,
        at: input.at,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] context engine assistant conversation write failed: ${errorMessage(err)}`);
    }
  }
}

function toChatContextPreparedTurn(turn: ContextEnginePreparedTurn): ChatContextPreparedTurn {
  if (turn.status === "ready") {
    return {
      status: "ready",
      sessionId: turn.sessionId,
      runId: turn.runId,
      workId: turn.workId,
      ref: turn.ref,
      context: turn.context,
    } satisfies ChatContextReadyTurn;
  }

  return {
    status: "ambiguous",
    sessionId: turn.sessionId,
    context: turn.context,
    message: turn.message,
    candidateCount: turn.candidateCount,
  } satisfies ChatContextAmbiguousTurn;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
