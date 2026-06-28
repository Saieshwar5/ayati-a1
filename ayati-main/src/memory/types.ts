import type { PromptPersonalMemory } from "./personal/types.js";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sessionPath: string;
  seq?: number;
  workRunId?: string;
  assistantResponseKind?: AssistantResponseKind;
}

export interface ConversationExchange {
  user: {
    seq?: number;
    timestamp: string;
    content: string;
  };
  assistant?: {
    seq?: number;
    timestamp: string;
    content: string;
    responseKind?: AssistantResponseKind;
  };
}

export type AgentResponseKind = "reply" | "feedback" | "notification" | "none";
export type AssistantResponseKind = Exclude<AgentResponseKind, "none">;

export type FeedbackKind = "approval" | "confirmation" | "clarification";

export interface SystemActivityItem {
  seq?: number;
  timestamp: string;
  source: string;
  event: string;
  eventId: string;
  summary: string;
  note?: string;
  responseKind?: AgentResponseKind;
  userVisible: boolean;
}

export type PromptSessionEvent =
  | {
      type: "user_message";
      seq: number;
      timestamp: string;
      content: string;
    }
  | {
      type: "assistant_response";
      seq: number;
      timestamp: string;
      workRunId?: string;
      content: string;
      responseKind?: AssistantResponseKind;
    }
  | {
      type: "system_event";
      seq: number;
      timestamp: string;
      source: string;
      event: string;
      eventId: string;
      summary: string;
    };

export type ToolEventStatus = "success" | "failed";

export interface PromptMemoryContext {
  recentExchanges: ConversationExchange[];
  sessionEvents?: PromptSessionEvent[];
  recentSystemEvents: SystemActivityItem[];
  conversationTurns: ConversationTurn[];
  personalMemorySnapshot?: string;
  personalMemories?: PromptPersonalMemory[];
  activeSessionPath?: string;
}

export interface MemoryRunHandle {
  sessionId: string;
  runId: string;
  triggerSeq?: number;
}

export interface SessionInputHandle {
  sessionId: string;
  seq: number;
}

export interface ToolCallRecordInput {
  runId: string;
  sessionId: string;
  stepId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolCallResultRecordInput {
  runId: string;
  sessionId: string;
  stepId: number;
  toolCallId: string;
  toolName: string;
  status: ToolEventStatus;
  output?: string;
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface AgentStepRecordInput {
  runId: string;
  sessionId: string;
  step: number;
  phase: string;
  summary: string;
  actionToolName?: string;
  endStatus?: string;
}

export interface AssistantMessageMetadata {
  responseKind?: AssistantResponseKind;
}

export interface RunRecorder {
  recordToolCall(clientId: string, input: ToolCallRecordInput): void;
  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void;
  recordAssistantFinal(
    clientId: string,
    runId: string,
    sessionId: string,
    content: string,
    metadata?: AssistantMessageMetadata,
  ): void;
  recordRunFailure(clientId: string, runId: string, sessionId: string, message: string): void;
  recordAgentStep(clientId: string, input: AgentStepRecordInput): void;
}
