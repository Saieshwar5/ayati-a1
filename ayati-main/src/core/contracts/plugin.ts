import { randomUUID } from "node:crypto";
import type {
  ExternalSystemIngressResult,
  ExternalSystemRequest,
  SystemAdapter,
} from "./system-ingress.js";

export type SystemEventIntentKind = "reminder" | "task" | "notification" | "unknown";
export type SystemEventClass =
  | "message_received"
  | "trigger_fired"
  | "task_requested"
  | "state_changed"
  | "artifact_received"
  | "approval_response";
export type SystemEventTrustTier = "internal" | "trusted_system" | "external";
export type SystemEventEffectLevel = "observe" | "assist" | "act" | "act_external";
export type SystemEventCreatedBy = "user" | "agent" | "system" | "external" | "unknown";

export interface SystemEventIntentMetadata {
  kind?: SystemEventIntentKind;
  eventClass?: SystemEventClass;
  trustTier?: SystemEventTrustTier;
  effectLevel?: SystemEventEffectLevel;
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
  queued?: boolean;
  queueId?: number;
  dedupeKey?: string;
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
  const eventClass = isSystemEventClass(intent.eventClass) ? intent.eventClass : undefined;
  const trustTier = isSystemEventTrustTier(intent.trustTier) ? intent.trustTier : undefined;
  const effectLevel = isSystemEventEffectLevel(intent.effectLevel) ? intent.effectLevel : undefined;
  const requestedAction = typeof intent.requestedAction === "string" && intent.requestedAction.trim().length > 0
    ? intent.requestedAction.trim()
    : undefined;
  const createdBy = isSystemEventCreatedBy(intent.createdBy) ? intent.createdBy : undefined;

  if (!kind && !eventClass && !trustTier && !effectLevel && !requestedAction && !createdBy) {
    return undefined;
  }

  return {
    ...(kind ? { kind } : {}),
    ...(eventClass ? { eventClass } : {}),
    ...(trustTier ? { trustTier } : {}),
    ...(effectLevel ? { effectLevel } : {}),
    ...(requestedAction ? { requestedAction } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

function isSystemEventIntentKind(value: unknown): value is SystemEventIntentKind {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown";
}

function isSystemEventCreatedBy(value: unknown): value is SystemEventCreatedBy {
  return value === "user" || value === "agent" || value === "system" || value === "external" || value === "unknown";
}

function isSystemEventClass(value: unknown): value is SystemEventClass {
  return value === "message_received"
    || value === "trigger_fired"
    || value === "task_requested"
    || value === "state_changed"
    || value === "artifact_received"
    || value === "approval_response";
}

function isSystemEventTrustTier(value: unknown): value is SystemEventTrustTier {
  return value === "internal" || value === "trusted_system" || value === "external";
}

function isSystemEventEffectLevel(value: unknown): value is SystemEventEffectLevel {
  return value === "observe" || value === "assist" || value === "act" || value === "act_external";
}

export interface PluginRuntimeContext {
  clientId: string;
  dataDir: string;
  projectRoot: string;
  publishSystemEvent(event: PluginSystemEventInput): Promise<SystemEventPublishResult>;
  emitSystemEvent?(event: PluginSystemEventInput): Promise<SystemEventPublishResult>;
  registerSystemAdapter?(adapter: SystemAdapter): void;
  ingestExternalRequest?(request: ExternalSystemRequest): Promise<ExternalSystemIngressResult>;
}

export interface AyatiPlugin {
  name: string;
  version: string;
  start(context: PluginRuntimeContext): void | Promise<void>;
  stop(context?: PluginRuntimeContext): void | Promise<void>;
}
