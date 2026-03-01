export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sessionPath: string;
}

export type ToolEventStatus = "success" | "failed";

export interface ToolMemoryEvent {
  timestamp: string;
  sessionPath: string;
  toolName: string;
  eventType: "tool_call" | "tool_result";
  args: string;
  status?: ToolEventStatus;
  output: string;
  errorMessage?: string;
}

export interface AgentStepMemoryEvent {
  timestamp: string;
  sessionPath: string;
  step: number;
  phase: string;
  summary: string;
  actionToolName?: string;
  endStatus?: string;
}

export interface SessionStatus {
  contextPercent: number;
  turns: number;
  sessionAgeMinutes: number;
}

export interface PromptMemoryContext {
  conversationTurns: ConversationTurn[];
  previousSessionSummary: string;
  activeTopicLabel?: string;
}

export interface MemoryRunHandle {
  sessionId: string;
  runId: string;
}

export type TurnStatusType =
  | "processing_started"
  | "response_started"
  | "response_completed"
  | "response_failed"
  | "session_switched"
  | "activity_switched";

export interface TurnStatusRecordInput {
  runId: string;
  sessionId: string;
  status: TurnStatusType;
  note?: string;
}

export interface CreateSessionInput {
  runId: string;
  reason: string;
  source?: "agent" | "external" | "system";
  confidence?: number;
  handoffSummary?: string;
}

export interface CreateSessionResult {
  previousSessionId: string | null;
  sessionId: string;
  sessionPath: string;
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

export type RunLedgerState = "started" | "completed";

export interface RunLedgerRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
  state: RunLedgerState;
  status?: "completed" | "failed" | "stuck";
  summary?: string;
}

export interface TaskSummaryRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  summary: string;
}

export interface SystemEventRecordInput {
  source: string;
  event: string;
  eventId: string;
  occurrenceId?: string;
  reminderId?: string;
  instruction?: string;
  scheduledFor?: string;
  triggeredAt?: string;
  payload?: Record<string, unknown>;
}

export interface SystemEventOutcomeRecordInput {
  runId: string;
  eventId: string;
  source: string;
  event: string;
  status: "completed" | "failed";
  note?: string;
}

export interface SessionMemory {
  initialize(clientId: string): void;
  shutdown(): void | Promise<void>;
  beginRun(clientId: string, userMessage: string): MemoryRunHandle;
  beginSystemRun?(clientId: string, input: SystemEventRecordInput): MemoryRunHandle;
  recordTurnStatus?(clientId: string, input: TurnStatusRecordInput): void;
  createSession?(clientId: string, input: CreateSessionInput): CreateSessionResult;
  recordToolCall(clientId: string, input: ToolCallRecordInput): void;
  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void;
  recordAssistantFinal(clientId: string, runId: string, sessionId: string, content: string): void;
  recordRunFailure(clientId: string, runId: string, sessionId: string, message: string): void;
  recordAgentStep(clientId: string, input: AgentStepRecordInput): void;
  recordRunLedger?(clientId: string, input: RunLedgerRecordInput): void;
  recordTaskSummary?(clientId: string, input: TaskSummaryRecordInput): void;
  recordSystemEventOutcome?(clientId: string, input: SystemEventOutcomeRecordInput): void;
  recordAssistantFeedback(clientId: string, runId: string, sessionId: string, message: string): void;
  getPromptMemoryContext(): PromptMemoryContext;
  getSessionStatus?(): SessionStatus | null;
  setStaticTokenBudget(tokens: number): void;
}
