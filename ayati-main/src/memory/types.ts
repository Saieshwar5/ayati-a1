export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sessionPath: string;
  seq?: number;
  workRunId?: string;
  assistantResponseKind?: AssistantResponseKind;
}

export type AgentResponseKind = "reply" | "feedback" | "notification" | "none";
export type AssistantResponseKind = Exclude<AgentResponseKind, "none">;

export type FeedbackKind = "approval" | "confirmation" | "clarification";

export interface SessionInputHandle {
  sessionId: string;
  seq: number;
  currentMessageId?: string;
}
