import { randomUUID } from "node:crypto";

export interface PluginSystemEventInput {
  source: string;
  eventName: string;
  summary: string;
  payload: Record<string, unknown>;
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
}

export interface SystemEventPublishResult {
  accepted: true;
  event: AyatiSystemEvent;
}

export function normalizeSystemEvent(input: PluginSystemEventInput): AyatiSystemEvent {
  return {
    type: "system_event",
    eventId: input.eventId?.trim() || randomUUID(),
    source: input.source.trim(),
    eventName: input.eventName.trim(),
    receivedAt: input.receivedAt?.trim() || new Date().toISOString(),
    summary: input.summary.trim(),
    payload: input.payload,
  };
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
