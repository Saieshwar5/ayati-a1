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

export interface PromptMemoryContext {
  recentExchanges: ConversationExchange[];
  sessionEvents?: PromptSessionEvent[];
  recentSystemEvents: SystemActivityItem[];
  conversationTurns: ConversationTurn[];
  personalMemorySnapshot?: string;
  personalMemories?: PromptPersonalMemory[];
  activeSessionPath?: string;
}

export interface SessionInputHandle {
  sessionId: string;
  seq: number;
  currentMessageId?: string;
}
