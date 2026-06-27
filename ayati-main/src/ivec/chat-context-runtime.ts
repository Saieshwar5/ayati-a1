import type { ContextEngineMachineContext } from "../context-engine/index.js";
import type { AgentLoopResult } from "./types.js";

export interface ChatContextRuntimePrepareInput {
  clientId: string;
  userMessage: string;
  at: string;
}

export interface ChatContextReadyTurn {
  status: "ready";
  sessionId: string;
  runId: string;
  workId: string;
  ref: string;
  context: ContextEngineMachineContext;
}

export interface ChatContextAmbiguousTurn {
  status: "ambiguous";
  sessionId: string;
  context: ContextEngineMachineContext;
  message: string;
  candidateCount?: number;
}

export type ChatContextPreparedTurn =
  | ChatContextReadyTurn
  | ChatContextAmbiguousTurn;

export interface ChatContextRuntimeCompleteInput {
  clientId: string;
  turn: ChatContextReadyTurn;
  result: AgentLoopResult;
  at: string;
}

export interface ChatContextCommittedRun {
  workId: string;
  workCommit?: string;
  runRef?: string;
}

export interface ChatContextRuntimeAssistantMessageInput {
  clientId: string;
  turn: ChatContextPreparedTurn | null;
  message: string;
  at: string;
}

export interface ChatContextRuntime {
  prepareUserTurn(input: ChatContextRuntimePrepareInput): Promise<ChatContextPreparedTurn | null>;
  completePreparedRun(input: ChatContextRuntimeCompleteInput): Promise<ChatContextCommittedRun | null>;
  recordAssistantMessage(input: ChatContextRuntimeAssistantMessageInput): Promise<void>;
}
