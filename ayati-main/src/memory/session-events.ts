import type { AssistantResponseKind } from "./types.js";
import type { TaskThread } from "./types.js";

export type SessionEventType =
  | "session_open"
  | "user_message"
  | "assistant_response"
  | "system_event"
  | "task_thread_update";

interface BaseEvent {
  v: 1;
  seq?: number;
  ts: string;
  type: SessionEventType;
  sessionId: string;
  sessionPath: string;
  sessionDate: string;
}

export interface SessionOpenEvent extends BaseEvent {
  type: "session_open";
  clientId: string;
}

export interface UserMessageEvent extends BaseEvent {
  type: "user_message";
  content: string;
}

export interface AssistantResponseEvent extends BaseEvent {
  type: "assistant_response";
  workRunId?: string;
  content: string;
  responseKind?: AssistantResponseKind;
}

export interface SystemEventEntry extends BaseEvent {
  type: "system_event";
  source: string;
  event: string;
  eventId: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface TaskThreadUpdateEvent extends BaseEvent {
  type: "task_thread_update";
  taskThread: TaskThread;
}

export type SessionEvent =
  | SessionOpenEvent
  | UserMessageEvent
  | AssistantResponseEvent
  | SystemEventEntry
  | TaskThreadUpdateEvent;

export function serializeEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

export function deserializeEvent(line: string): SessionEvent {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed["v"] !== 1) {
    throw new Error(`Unsupported session event version: ${String(parsed["v"])}`);
  }
  return parsed as unknown as SessionEvent;
}
