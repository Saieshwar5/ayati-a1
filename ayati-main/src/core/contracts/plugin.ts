import { randomUUID } from "node:crypto";

export type SystemEventIntentKind = "reminder" | "task" | "notification" | "unknown";
export type SystemEventCreatedBy = "user" | "system" | "external" | "unknown";

export interface SystemEventIntentMetadata {
  kind?: SystemEventIntentKind;
  requestedAction?: string;
  createdBy?: SystemEventCreatedBy;
}

export interface PluginSystemEventInput {
  source: string;
  eventName: string;
  summary: string;
  payload: Record<string, unknown>;
  intent?: SystemEventIntentMetadata;
  eventId?: string;
  receivedAt?: string;
}

export interface AyatiSystemEvent {
  type: "system_event";
  eventId: string;
  source: string;
  eventName: string;
  receivedAt: string;
  summary: string;
  payload: Record<string, unknown>;
  intent?: SystemEventIntentMetadata;
}

export interface SystemEventPublishResult {
  accepted: true;
  event: AyatiSystemEvent;
}

export function normalizeSystemEvent(input: PluginSystemEventInput): AyatiSystemEvent {
  const intent = normalizeSystemEventIntent(input.intent);
  return {
    type: "system_event",
    eventId: input.eventId?.trim() || randomUUID(),
    source: input.source.trim(),
    eventName: input.eventName.trim(),
    receivedAt: input.receivedAt?.trim() || new Date().toISOString(),
    summary: input.summary.trim(),
    payload: input.payload,
    ...(intent ? { intent } : {}),
  };
}

function normalizeSystemEventIntent(intent: SystemEventIntentMetadata | undefined): SystemEventIntentMetadata | undefined {
  if (!intent) {
    return undefined;
  }

  const kind = isSystemEventIntentKind(intent.kind) ? intent.kind : undefined;
  const requestedAction = typeof intent.requestedAction === "string" && intent.requestedAction.trim().length > 0
    ? intent.requestedAction.trim()
    : undefined;
  const createdBy = isSystemEventCreatedBy(intent.createdBy) ? intent.createdBy : undefined;

  if (!kind && !requestedAction && !createdBy) {
    return undefined;
  }

  return {
    ...(kind ? { kind } : {}),
    ...(requestedAction ? { requestedAction } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

function isSystemEventIntentKind(value: unknown): value is SystemEventIntentKind {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown";
}

function isSystemEventCreatedBy(value: unknown): value is SystemEventCreatedBy {
  return value === "user" || value === "system" || value === "external" || value === "unknown";
}

export interface PluginRuntimeContext {
  clientId: string;
  dataDir: string;
  projectRoot: string;
  publishSystemEvent(event: PluginSystemEventInput): Promise<SystemEventPublishResult>;
  emitSystemEvent?(event: PluginSystemEventInput): Promise<SystemEventPublishResult>;
}

export interface AyatiPlugin {
  name: string;
  version: string;
  start(context: PluginRuntimeContext): void | Promise<void>;
  stop(context?: PluginRuntimeContext): void | Promise<void>;
}
