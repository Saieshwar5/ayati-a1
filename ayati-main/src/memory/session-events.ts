import type {
  AgentResponseKind,
  AssistantResponseKind,
  FeedbackKind,
  TaskSummaryTaskStatus,
  ToolEventStatus,
} from "./types.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";

type LegacyFeedbackResolutionOutcome = "completed" | "rejected" | "expired";

export type SessionEventType =
  | "session_open"
  | "session_close"
  | "user_message"
  | "assistant_message"
  | "turn_status"
  | "tool_call"
  | "tool_result"
  | "run_failure"
  | "agent_step"
  | "run_ledger"
  | "active_attachments"
  | "task_summary"
  | "assistant_feedback"
  | "assistant_notification"
  | "feedback_opened"
  | "feedback_resolved"
  | "system_event_received"
  | "system_event_processed";

interface BaseEvent {
  v: 2;
  ts: string;
  type: SessionEventType;
  sessionId: string;
  sessionPath: string;
}

export interface SessionOpenEvent extends BaseEvent {
  type: "session_open";
  clientId: string;
  parentSessionId?: string;
  handoffSummary?: string;
}

export interface SessionCloseEvent extends BaseEvent {
  type: "session_close";
  reason: string;
  tokenAtClose: number;
  eventCount: number;
  handoffSummary?: string;
  nextSessionId?: string;
  nextSessionPath?: string;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user_message";
  runId?: string;
  content: string;
}

export interface AssistantMessageEvent extends BaseEvent {
  type: "assistant_message";
  runId?: string;
  content: string;
  responseKind?: AssistantResponseKind;
}

export interface TurnStatusEvent extends BaseEvent {
  type: "turn_status";
  status: "processing_started" | "response_started" | "response_completed" | "response_failed" | "session_switched" | "activity_switched";
  note?: string;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  stepId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  stepId: number;
  toolCallId: string;
  toolName: string;
  status: ToolEventStatus;
  output: string;
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface RunFailureEvent extends BaseEvent {
  type: "run_failure";
  message: string;
}

export interface AgentStepEvent extends BaseEvent {
  type: "agent_step";
  step: number;
  phase: string;
  summary: string;
  approachesTried: string[];
  actionToolName?: string;
  endStatus?: string;
}

export interface RunLedgerEvent extends BaseEvent {
  type: "run_ledger";
  runId: string;
  runPath: string;
  state: "started" | "completed";
  status?: "completed" | "failed" | "stuck";
  summary?: string;
}

export interface ActiveAttachmentsEvent extends BaseEvent {
  type: "active_attachments";
  runId: string;
  runPath: string;
  action: "prepared" | "restored" | "used";
  attachments: Array<{
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
    detail?: Record<string, unknown>;
  }>;
}

export interface TaskSummaryEvent extends BaseEvent {
  type: "task_summary";
  runId: string;
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
  stopReason?: "completed" | "needs_user_input" | "blocked" | "failed" | "stuck";
  attachmentNames?: string[];
}

export interface AssistantFeedbackEvent extends BaseEvent {
  type: "assistant_feedback";
  message: string;
}

export interface AssistantNotificationEvent extends BaseEvent {
  type: "assistant_notification";
  message: string;
  source?: string;
  event?: string;
  eventId?: string;
}

export interface FeedbackOpenedEvent extends BaseEvent {
  type: "feedback_opened";
  runId: string;
  feedbackId: string;
  kind: FeedbackKind;
  shortLabel: string;
  message: string;
  actionType?: string;
  sourceEventId?: string;
  entityHints: string[];
  payloadSummary?: string;
  expiresAt: string;
}

export interface FeedbackResolvedEvent extends BaseEvent {
  type: "feedback_resolved";
  runId: string;
  feedbackId: string;
  resolution: LegacyFeedbackResolutionOutcome;
  userResponse?: string;
}

export interface SystemEventReceivedEvent extends BaseEvent {
  type: "system_event_received";
  runId: string;
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

export interface SystemEventProcessedEvent extends BaseEvent {
  type: "system_event_processed";
  runId: string;
  source: string;
  event: string;
  eventId: string;
  summary?: string;
  responseKind?: AgentResponseKind;
  status: "completed" | "failed";
  note?: string;
}

export type SessionEvent =
  | SessionOpenEvent
  | SessionCloseEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | TurnStatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | RunLedgerEvent
  | ActiveAttachmentsEvent
  | TaskSummaryEvent
  | AssistantFeedbackEvent
  | AssistantNotificationEvent
  | FeedbackOpenedEvent
  | FeedbackResolvedEvent
  | SystemEventReceivedEvent
  | SystemEventProcessedEvent;

export type CountableSessionEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantFeedbackEvent;

export type ToolSessionEvent =
  | ToolCallEvent
  | ToolResultEvent;

const COUNTABLE_EVENT_TYPES = new Set<SessionEventType>([
  "user_message",
  "assistant_message",
  "assistant_feedback",
]);

export function isCountableSessionEvent(event: SessionEvent): event is CountableSessionEvent {
  return COUNTABLE_EVENT_TYPES.has(event.type);
}

export function isAgentStepEvent(event: SessionEvent): event is AgentStepEvent {
  return event.type === "agent_step";
}

export function serializeEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

export function deserializeEvent(line: string): SessionEvent {
  const parsed = JSON.parse(line) as {
    v?: number;
    sessionPath?: string;
    sessionId?: string;
    [key: string]: unknown;
  };
  if (parsed.v !== 1 && parsed.v !== 2) {
    throw new Error(`Unsupported event version: ${String(parsed.v)}`);
  }

  if (parsed.v === 1) {
    const fallbackPath = parsed.sessionPath && parsed.sessionPath.length > 0
      ? parsed.sessionPath
      : `sessions/legacy/${parsed.sessionId}.md`;
    return {
      ...(parsed as Record<string, unknown>),
      v: 2,
      sessionPath: fallbackPath,
    } as SessionEvent;
  }

  return parsed as unknown as SessionEvent;
}
