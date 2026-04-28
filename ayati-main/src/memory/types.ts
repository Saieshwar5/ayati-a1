import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";
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
  runId?: string;
  assistantResponseKind?: AssistantResponseKind;
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
  contextPercent: number;
  turns: number;
  sessionAgeMinutes: number;
  startedAt: string;
  handoffPhase: SessionHandoffPhase;
  pendingRotationReason: SessionRotationReason | null;
}

export interface PromptRunLedger {
  timestamp: string;
  runId: string;
  runPath: string;
  state: "started" | "completed";
  status?: "completed" | "failed" | "stuck";
  summary?: string;
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
  workMode?: string;
  userMessage?: string;
  assistantResponse?: string;
  approach?: string;
  sessionContextSummary?: string;
  dependentTaskRunId?: string;
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

export interface ActiveAttachmentRef {
  documentId: string;
  displayName: string;
  kind: string;
  mode: string;
  runId: string;
  runPath: string;
  preparedInputId: string;
  lastUsedAt: string;
  lastAction: string;
}

export interface ActiveAttachmentRecord extends ActiveAttachmentRef {
  manifest: ManagedDocumentManifest;
  summary: PreparedAttachmentSummary;
  detail: Record<string, unknown>;
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
  activeAttachments: ActiveAttachmentRef[];
  recentRuns: PromptRunLedger[];
  recentTasks: PromptTaskSummary[];
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
  conversationTurns: ConversationTurn[];
  previousSessionSummary: string;
  personalMemorySnapshot?: string;
  personalMemories?: PromptPersonalMemory[];
  activeTopicLabel?: string;
  activeSessionPath?: string;
  recentRunLedgers?: PromptRunLedger[];
  recentTaskSummaries?: PromptTaskSummary[];
  activeAttachments?: ActiveAttachmentRef[];
  recentSystemActivity?: SystemActivityItem[];
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

export type RunLedgerState = "started" | "completed";

export interface RunLedgerRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
  state: RunLedgerState;
  status?: "completed" | "failed" | "stuck";
  summary?: string;
}

export interface ActiveAttachmentsRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
  action: "prepared" | "restored" | "used";
  attachments: Array<{
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
    detail?: Record<string, unknown>;
  }>;
}

export interface TaskSummaryRecordInput {
  runId: string;
  sessionId: string;
  runPath: string;
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
  workMode?: string;
  userMessage?: string;
  assistantResponse?: string;
  approach?: string;
  sessionContextSummary?: string;
  dependentTaskRunId?: string;
  assistantResponseKind?: AssistantResponseKind;
  feedbackKind?: FeedbackKind;
  feedbackLabel?: string;
  actionType?: string;
  entityHints?: string[];
  goalDoneWhen?: string[];
  goalRequiredEvidence?: string[];
  nextAction?: string;
  stopReason?: TaskSummaryStopReason;
  attachmentNames?: string[];
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
  recordRunLedger?(clientId: string, input: RunLedgerRecordInput): void;
  recordActiveAttachments?(clientId: string, input: ActiveAttachmentsRecordInput): void;
  recordTaskSummary?(clientId: string, input: TaskSummaryRecordInput): void;
  queueTaskSummary?(clientId: string, input: TaskSummaryRecordInput): void | Promise<void>;
  recordSystemEventOutcome?(clientId: string, input: SystemEventOutcomeRecordInput): void;
  recordAssistantNotification?(clientId: string, input: AssistantNotificationRecordInput): void;
  getPromptMemoryContext(): PromptMemoryContext;
  getActiveAttachmentRecords?(): ActiveAttachmentRecord[];
  getSessionStatus?(): SessionStatus | null;
  updateSessionLifecycle?(clientId: string, input: SessionLifecycleUpdateInput): void | Promise<void>;
  flushPersistence?(): Promise<void>;
  setStaticTokenBudget(tokens: number): void;
}
