export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export type ToolEventStatus = "success" | "failed";

export interface ToolMemoryEvent {
  timestamp: string;
  toolName: string;
  status: ToolEventStatus;
  argsPreview: string;
  outputPreview: string;
  errorMessage?: string;
}

export interface PromptMemoryContext {
  conversationTurns: ConversationTurn[];
  previousSessionSummary: string;
  toolEvents: ToolMemoryEvent[];
}

export interface MemoryRunHandle {
  sessionId: string;
  runId: string;
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

export interface SessionMemory {
  initialize(clientId: string): void;
  shutdown(): void;
  beginRun(clientId: string, userMessage: string): MemoryRunHandle;
  recordToolCall(clientId: string, input: ToolCallRecordInput): void;
  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void;
  recordAssistantFinal(clientId: string, runId: string, sessionId: string, content: string): void;
  recordRunFailure(clientId: string, runId: string, sessionId: string, message: string): void;
  getPromptMemoryContext(): PromptMemoryContext;
}
