import type { AyatiSystemEvent, PluginSystemEventInput } from "./plugin.js";

export type InboundSourceType = "internal" | "external";
export type InboundTransport = "direct" | "webhook" | "poller";
export type InboundAuthMode = "none" | "token" | "signature" | "custom";

export interface CanonicalInboundEvent extends AyatiSystemEvent {}

export interface SourceManifest {
  sourceId: string;
  displayName: string;
  sourceType: InboundSourceType;
  transport: InboundTransport;
  authMode: InboundAuthMode;
  defaultEnabled: boolean;
  defaultPolicyMode?: string;
  supportsRawPersistence?: boolean;
}

export interface ExternalSystemRequest {
  source: string;
  clientId: string;
  method?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
  payload?: unknown;
  receivedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterVerificationResult {
  ok: boolean;
  reason?: string;
}

export interface InboundQueueEventReceipt {
  event: CanonicalInboundEvent;
  dedupeKey: string;
  queued: boolean;
  queueId?: number;
}

export interface ExternalSystemIngressResult {
  accepted: boolean;
  source: string;
  queuedCount: number;
  duplicateCount: number;
  receipts: InboundQueueEventReceipt[];
  reason?: string;
}

export interface SystemAdapter {
  manifest(): SourceManifest;
  canHandle(input: ExternalSystemRequest): boolean;
  normalize(input: ExternalSystemRequest): Promise<readonly (PluginSystemEventInput | CanonicalInboundEvent)[]> | readonly (PluginSystemEventInput | CanonicalInboundEvent)[];
  verify?(input: ExternalSystemRequest): Promise<AdapterVerificationResult> | AdapterVerificationResult;
  dedupeKey?(event: CanonicalInboundEvent, input: ExternalSystemRequest): string;
}
