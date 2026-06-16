import type { FocusAssetRef, FocusShelfItem } from "./focus/types.js";
import type { FocusStore } from "./focus/focus-store.js";
import type { PromptPersonalMemory } from "./personal/types.js";
import type {
  SystemEventCreatedBy,
  SystemEventClass,
  SystemEventEffectLevel,
  SystemEventTrustTier,
} from "../core/contracts/plugin.js";

export type { FocusAssetRef, FocusCard, FocusRunRef, FocusScope, FocusShelfItem } from "./focus/types.js";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sessionPath: string;
  runId?: string;
  assistantResponseKind?: AssistantResponseKind;
}

export interface ConversationExchange {
  runId: string;
  user: {
    timestamp: string;
    content: string;
  };
  assistant?: {
    timestamp: string;
    content: string;
    responseKind?: AssistantResponseKind;
  };
}

export type AgentResponseKind = "reply" | "feedback" | "notification" | "none";
export type AssistantResponseKind = Exclude<AgentResponseKind, "none">;

export type FeedbackKind = "approval" | "confirmation" | "clarification";

export interface SystemActivityItem {
  timestamp: string;
  source: string;
  event: string;
  eventId: string;
  summary: string;
  note?: string;
  responseKind?: AgentResponseKind;
  userVisible: boolean;
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

export type TaskSummaryTaskStatus = "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input";
export type TaskSummaryStopReason = "completed" | "needs_user_input" | "blocked" | "failed" | "stuck";

export interface PromptTaskSummary {
  timestamp: string;
  runId: string;
  runPath: string;
  runStatus: "completed" | "failed" | "stuck";
  taskStatus: TaskSummaryTaskStatus;
  objective?: string;
  summary: string;
  progressSummary?: string;
  currentFocus?: string;
  completedMilestones: string[];
  openWork: string[];
  blockers: string[];
  keyFacts: string[];
  evidence: string[];
  userInputNeeded?: string;
  userMessage?: string;
  assistantResponse?: string;
  assistantResponseKind?: AssistantResponseKind;
  feedbackKind?: FeedbackKind;
  feedbackLabel?: string;
  actionType?: string;
  entityHints?: string[];
  goalDoneWhen?: string[];
  goalRequiredEvidence?: string[];
  nextAction?: string;
  stopReason?: TaskSummaryStopReason;
  attachmentNames: string[];
}

export interface SessionHandoffSnapshot {
  sessionId: string;
  parentSessionId: string | null;
  timezone: string;
  reason: SessionRotationReason | null;
  startedAt: string;
  lastActivityAt: string;
  activeGoals: string[];
  completedWork: string[];
  pendingWork: string[];
  keyFacts: string[];
  sessionFocusCards: FocusShelfItem[];
  recentDialog: ConversationTurn[];
  nextAction: string;
}

export interface SessionHandoffArtifact {
  summary: string;
  snapshot: SessionHandoffSnapshot;
  preparedAt: string;
  revision: number;
}

export interface PromptMemoryContext {
  recentExchanges: ConversationExchange[];
  recentSystemEvents: SystemActivityItem[];
  conversationTurns: ConversationTurn[];
  personalMemorySnapshot?: string;
  personalMemories?: PromptPersonalMemory[];
  activeFocus?: FocusShelfItem[];
  sessionFocusCards?: FocusShelfItem[];
  attentionShelf?: FocusShelfItem[];
  activeTopicLabel?: string;
  activeSessionPath?: string;
  recentTaskSummaries?: PromptTaskSummary[];
}

export interface MemoryRunHandle {
  sessionId: string;
  runId: string;
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

export interface TaskSummaryRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
  focusId?: string;
  status: "completed" | "failed" | "stuck";
  taskStatus?: TaskSummaryTaskStatus;
  objective?: string;
  summary: string;
  progressSummary?: string;
  currentFocus?: string;
  completedMilestones?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  userInputNeeded?: string;
  userMessage?: string;
  assistantResponse?: string;
  assistantResponseKind?: AssistantResponseKind;
  feedbackKind?: FeedbackKind;
  feedbackLabel?: string;
  actionType?: string;
  entityHints?: string[];
  toolsUsed?: string[];
  goalDoneWhen?: string[];
  goalRequiredEvidence?: string[];
  nextAction?: string;
  stopReason?: TaskSummaryStopReason;
  attachmentNames?: string[];
  focusAssets?: FocusAssetRef[];
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
  runId: string;
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
  runId: string;
  sessionId: string;
  message: string;
  source?: string;
  event?: string;
  eventId?: string;
}

export interface AssistantMessageRecordInput {
  responseKind?: AssistantResponseKind;
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
  recordAssistantFinal(
    clientId: string,
    runId: string,
    sessionId: string,
    content: string,
    metadata?: AssistantMessageRecordInput,
  ): void;
  recordRunFailure(clientId: string, runId: string, sessionId: string, message: string): void;
  recordAgentStep(clientId: string, input: AgentStepRecordInput): void;
  recordTaskSummary?(clientId: string, input: TaskSummaryRecordInput): void;
  queueTaskSummary?(clientId: string, input: TaskSummaryRecordInput): void | Promise<void>;
  recordSystemEventOutcome?(clientId: string, input: SystemEventOutcomeRecordInput): void;
  recordAssistantNotification?(clientId: string, input: AssistantNotificationRecordInput): void;
  getPromptMemoryContext(): PromptMemoryContext;
  getFocusStore?(): FocusStore;
  getSessionStatus?(): SessionStatus | null;
  updateSessionLifecycle?(clientId: string, input: SessionLifecycleUpdateInput): void | Promise<void>;
  flushPersistence?(): Promise<void>;
  setStaticTokenBudget(tokens: number): void;
}
