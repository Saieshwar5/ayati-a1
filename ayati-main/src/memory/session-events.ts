import type { ToolEventStatus } from "./types.js";

export type SessionEventType =
  | "session_open"
  | "session_close"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "run_failure"
  | "agent_step"
  | "assistant_feedback";

interface BaseEvent {
  v: 1;
  ts: string;
  type: SessionEventType;
  sessionId: string;
}

export interface SessionOpenEvent extends BaseEvent {
  type: "session_open";
  clientId: string;
  previousSessionSummary: string;
}

export interface SessionCloseEvent extends BaseEvent {
  type: "session_close";
  reason: string;
  summaryText: string;
  summaryId?: number;
  summaryKeywords?: string[];
  tokenAtClose?: number;
  driftScore?: number;
  infiniteTaskRef?: string;
  infiniteResumeFromRef?: string;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user_message";
  runId: string;
  content: string;
}

export interface AssistantMessageEvent extends BaseEvent {
  type: "assistant_message";
  runId: string;
  content: string;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  runId: string;
  stepId: number;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  runId: string;
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
  runId: string;
  message: string;
}

export interface AgentStepEvent extends BaseEvent {
  type: "agent_step";
  runId: string;
  step: number;
  phase: string;
  summary: string;
  approachesTried: string[];
  actionToolName?: string;
  endStatus?: string;
}

export interface AssistantFeedbackEvent extends BaseEvent {
  type: "assistant_feedback";
  runId: string;
  message: string;
}

export interface ToolContextEntry {
  v: 1;
  ts: string;
  sessionId: string;
  toolCallId: string;
  args: unknown;
  status: ToolEventStatus;
  output: string;
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
}

export type SessionEvent =
  | SessionOpenEvent
  | SessionCloseEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | AssistantFeedbackEvent;

export function serializeEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

export function deserializeEvent(line: string): SessionEvent {
  const parsed = JSON.parse(line) as SessionEvent;
  if (parsed.v !== 1) {
    throw new Error(`Unsupported event version: ${String(parsed.v)}`);
  }
  return parsed;
}
