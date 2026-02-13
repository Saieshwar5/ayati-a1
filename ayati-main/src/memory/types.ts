export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface SessionProfileMetadata {
  subtopics: string[];
  activeGoals: string[];
  constraints: string[];
  stableEntities: string[];
  decisionLog: string[];
  openLoops: string[];
}

export interface SessionProfile extends SessionProfileMetadata {
  title: string;
  scope: string;
  keywords: string[];
  anchors: string[];
  topicConfidence: number;
  updatedAt: string;
  version: number;
}

export interface TopicDriftDecision {
  isDrift: boolean;
  confidence: number;
  reason: string;
}

export interface SessionSummaryRecord {
  summaryText: string;
  keywords: string[];
  confidence: number;
  redactionFlags: string[];
}

export interface SessionSummarySearchHit {
  sessionId: string;
  summaryText: string;
  keywords: string[];
  closedAt: string;
  closeReason: string;
  score: number;
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

export interface RecalledContextEvidence {
  sessionId: string;
  turnRef: string;
  timestamp: string;
  snippet: string;
  whyRelevant: string;
  confidence: number;
}

export interface ContextRecallStatus {
  status: "skipped" | "not_found" | "found" | "partial";
  reason: string;
  searchedSessions: number;
  modelCalls: number;
  triggerReason?: string;
}

export interface PromptMemoryContext {
  conversationTurns: ConversationTurn[];
  previousSessionSummary: string;
  toolEvents: ToolMemoryEvent[];
  recalledEvidence?: RecalledContextEvidence[];
  contextRecallStatus?: ContextRecallStatus;
  activeTopicLabel?: string;
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
  shutdown(): void | Promise<void>;
  beginRun(clientId: string, userMessage: string): MemoryRunHandle;
  recordToolCall(clientId: string, input: ToolCallRecordInput): void;
  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void;
  recordAssistantFinal(clientId: string, runId: string, sessionId: string, content: string): void;
  recordRunFailure(clientId: string, runId: string, sessionId: string, message: string): void;
  getPromptMemoryContext(): PromptMemoryContext;
  setStaticTokenBudget(tokens: number): void;
  searchSessionSummaries(query: string, limit?: number): SessionSummarySearchHit[];
  loadSessionTurns(sessionId: string): ConversationTurn[];
}
