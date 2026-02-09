import type { ToolEventStatus } from "./types.js";

export type SessionEventType =
  | "session_open"
  | "session_close"
  | "session_tier_change"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "run_failure";

export type SessionTier = "high" | "medium" | "low" | "rare";

interface BaseEvent {
  v: 1;
  ts: string;
  type: SessionEventType;
  sessionId: string;
}

export interface SessionOpenEvent extends BaseEvent {
  type: "session_open";
  clientId: string;
  tier: SessionTier;
  hardCapMinutes: number;
  idleTimeoutMinutes: number;
  previousSessionSummary: string;
}

export interface SessionCloseEvent extends BaseEvent {
  type: "session_close";
  reason: string;
  summaryText: string;
}

export interface SessionTierChangeEvent extends BaseEvent {
  type: "session_tier_change";
  fromTier: SessionTier;
  toTier: SessionTier;
  score: number;
  hardCapMinutes: number;
  idleTimeoutMinutes: number;
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
  | SessionTierChangeEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent;

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
