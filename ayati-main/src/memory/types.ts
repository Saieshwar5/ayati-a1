import type { PromptPersonalMemory } from "./personal/types.js";
import type {
  SystemEventCreatedBy,
  SystemEventClass,
  SystemEventEffectLevel,
  SystemEventTrustTier,
} from "../core/contracts/plugin.js";

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

export type SessionRotationReason = "daily_cutover" | "context_threshold";
export type SessionHandoffPhase = "inactive" | "preparing" | "ready" | "finalized";

export interface SessionStatus {
  sessionId: string;
  sessionDate: string;
  activeSessionPath: string;
  contextPercent: number;
  turns: number;
  sessionAgeMinutes: number;
  startedAt: string;
  handoffPhase: SessionHandoffPhase;
  pendingRotationReason: SessionRotationReason | null;
}

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

export interface SessionLifecycleUpdateInput {
  runId: string;
  sessionId: string;
  timezone?: string | null;
  status: "completed" | "failed" | "stuck";
}

export type TurnStatusType =
  | "processing_started"
  | "response_started"
  | "response_completed"
  | "response_failed"
  | "session_switched";

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
  timezone?: string | null;
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

export interface SystemEventRecordInput {
  source: string;
  event: string;
  eventId: string;
  summary?: string;
  eventClass?: SystemEventClass;
  trustTier?: SystemEventTrustTier;
  effectLevel?: SystemEventEffectLevel;
  createdBy?: SystemEventCreatedBy;
  requestedAction?: string;
  modeApplied?: string;
  approvalState?: string;
  occurrenceId?: string;
  reminderId?: string;
  instruction?: string;
  scheduledFor?: string;
  triggeredAt?: string;
  payload?: Record<string, unknown>;
}

export interface SystemEventOutcomeRecordInput {
  workRunId?: string;
  eventId: string;
  source: string;
  event: string;
  status: "completed" | "failed";
  summary?: string;
  responseKind?: AgentResponseKind;
  approvalState?: string;
  note?: string;
}

export interface AssistantNotificationRecordInput {
  workRunId?: string;
  sessionId: string;
  message: string;
  source?: string;
  event?: string;
  eventId?: string;
}

export interface AssistantMessageMetadata {
  responseKind?: AssistantResponseKind;
}

export interface AssistantMessageRecordInput {
  sessionId: string;
  workRunId?: string;
  content: string;
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

export interface SessionMemory extends RunRecorder {
  initialize(clientId: string): void;
  shutdown(): void | Promise<void>;
  recordUserMessage(clientId: string, userMessage: string): SessionInputHandle;
  recordSystemEvent?(clientId: string, input: SystemEventRecordInput): SessionInputHandle;
  createWorkRun?(clientId: string, input: SessionInputHandle): MemoryRunHandle;
  recordTurnStatus?(clientId: string, input: TurnStatusRecordInput): void;
  createSession?(clientId: string, input: CreateSessionInput): CreateSessionResult;
  recordAssistantMessage(clientId: string, input: AssistantMessageRecordInput): void;
  recordSystemEventOutcome?(clientId: string, input: SystemEventOutcomeRecordInput): void;
  recordAssistantNotification?(clientId: string, input: AssistantNotificationRecordInput): void;
  getPromptMemoryContext(): PromptMemoryContext;
  getSessionStatus?(): SessionStatus | null;
  updateSessionLifecycle?(clientId: string, input: SessionLifecycleUpdateInput): void | Promise<void>;
  flushPersistence?(): Promise<void>;
  setStaticTokenBudget(tokens: number): void;
}
