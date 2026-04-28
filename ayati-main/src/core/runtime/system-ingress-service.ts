import {
  normalizeSystemEvent,
  type AyatiSystemEvent,
  type PluginSystemEventInput,
  type SystemEventPublishResult,
} from "../contracts/plugin.js";
import type {
  CanonicalInboundEvent,
  ExternalSystemIngressResult,
  ExternalSystemRequest,
  InboundQueueEventReceipt,
} from "../contracts/system-ingress.js";
import { devLog, devWarn } from "../../shared/index.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { InboundQueueStore } from "./inbound-queue-store.js";

export interface SystemIngressServiceOptions {
  adapterRegistry: AdapterRegistry;
  queueStore: InboundQueueStore;
}

export class SystemIngressService {
  private readonly adapterRegistry: AdapterRegistry;
  private readonly queueStore: InboundQueueStore;

  constructor(options: SystemIngressServiceOptions) {
    this.adapterRegistry = options.adapterRegistry;
    this.queueStore = options.queueStore;
  }

  async ingestInternalEvent(clientId: string, input: PluginSystemEventInput | AyatiSystemEvent): Promise<SystemEventPublishResult> {
    const event = toCanonicalEvent(input);
    const dedupeKey = deriveDefaultDedupeKey(event);
    const queued = this.queueStore.enqueue({
      clientId,
      source: event.source,
      event,
      dedupeKey,
    });
    devLog(
      `System event queued: source=${event.source} eventName=${event.eventName} eventId=${event.eventId} dedupeKey=${dedupeKey} queued=${queued.queued}`,
    );
    return {
      accepted: true,
      event,
      queued: queued.queued,
      ...(queued.queueId ? { queueId: queued.queueId } : {}),
      dedupeKey,
    };
  }

  async ingestExternalRequest(request: ExternalSystemRequest): Promise<ExternalSystemIngressResult> {
    const adapter = this.adapterRegistry.resolve(request);
    if (!adapter) {
      return {
        accepted: false,
        source: request.source,
        queuedCount: 0,
        duplicateCount: 0,
        receipts: [],
        reason: `No adapter registered for source ${request.source}.`,
      };
    }

    const verification = await adapter.verify?.(request);
    if (verification && !verification.ok) {
      return {
        accepted: false,
        source: request.source,
        queuedCount: 0,
        duplicateCount: 0,
        receipts: [],
        reason: verification.reason ?? "Request verification failed.",
      };
    }

    const normalized = await adapter.normalize(request);
    if (normalized.length === 0) {
      return {
        accepted: false,
        source: request.source,
        queuedCount: 0,
        duplicateCount: 0,
        receipts: [],
        reason: `Adapter ${adapter.manifest().sourceId} produced no canonical events.`,
      };
    }

    const manifest = adapter.manifest();
    const receipts: InboundQueueEventReceipt[] = [];
    let queuedCount = 0;
    let duplicateCount = 0;

    for (const item of normalized) {
      const event = toCanonicalEvent(item);
      const dedupeKey = adapter.dedupeKey?.(event, request) ?? deriveDefaultDedupeKey(event);
      const queued = this.queueStore.enqueue({
        clientId: request.clientId,
        source: event.source,
        event,
        dedupeKey,
        ...(manifest.supportsRawPersistence ? { rawRequest: request } : {}),
      });
      if (queued.queued) {
        queuedCount += 1;
      } else {
        duplicateCount += 1;
      }
      receipts.push({
        event,
        dedupeKey,
        queued: queued.queued,
        ...(queued.queueId ? { queueId: queued.queueId } : {}),
      });
    }

    devLog(
      `External ingress handled: source=${request.source} queued=${queuedCount} duplicates=${duplicateCount}`,
    );
    return {
      accepted: queuedCount > 0 || duplicateCount > 0,
      source: request.source,
      queuedCount,
      duplicateCount,
      receipts,
      ...(queuedCount === 0 && duplicateCount === 0 ? { reason: "No events were queued." } : {}),
    };
  }
}

function toCanonicalEvent(input: PluginSystemEventInput | CanonicalInboundEvent): CanonicalInboundEvent {
  const candidate = input as Partial<CanonicalInboundEvent>;
  if (candidate.type === "system_event" && typeof candidate.eventId === "string") {
    return candidate as CanonicalInboundEvent;
  }
  return normalizeSystemEvent(input as PluginSystemEventInput);
}

function deriveDefaultDedupeKey(event: CanonicalInboundEvent): string {
  const explicitDedupeKey = asNonEmptyString(event.payload["dedupeKey"]);
  if (explicitDedupeKey) {
    return explicitDedupeKey;
  }

  const occurrenceId = asNonEmptyString(event.payload["occurrenceId"]);
  if (occurrenceId) {
    return `${event.source}:occurrence:${occurrenceId}`;
  }

  const messageId = asNestedMessageId(event.payload);
  if (messageId) {
    return `${event.source}:message:${messageId}`;
  }

  return `${event.source}:${event.eventName}:${event.eventId}`;
}

function asNestedMessageId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload["messageId"] === "string" && payload["messageId"].trim().length > 0) {
    return payload["messageId"].trim();
  }

  const message = payload["message"];
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const messageId = (message as Record<string, unknown>)["message_id"] ?? (message as Record<string, unknown>)["messageId"];
    return asNonEmptyString(messageId);
  }

  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
