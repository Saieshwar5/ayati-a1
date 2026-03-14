import { createHash } from "node:crypto";
import type { PluginSystemEventInput } from "../../core/contracts/plugin.js";

const DEFAULT_WEBHOOK_PATH = "/webhooks/agentmail";
const SUBJECT_MAX_CHARS = 300;

interface ParsedAgentMailWebhook {
  eventType: string;
  eventId: string;
  senderEmail?: string;
  systemEvent: PluginSystemEventInput;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function capText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...[truncated]`;
}

function firstEmail(value: unknown): string | undefined {
  const parties = asRecordArray(value);
  return asString(parties[0]?.["email"]);
}

function inferEventId(payload: Record<string, unknown>, rawBody: string): string {
  const direct = asString(payload["event_id"]) ?? asString(payload["eventId"]);
  if (direct) return direct;

  const message = asRecord(payload["message"]);
  const messageId = asString(message?.["message_id"]) ?? asString(message?.["messageId"]);
  if (messageId) return `message:${messageId}`;

  return `hash:${createHash("sha256").update(rawBody).digest("hex").slice(0, 24)}`;
}

export function normalizeWebhookPath(rawPath: string | undefined): string {
  let normalized = rawPath?.trim() || DEFAULT_WEBHOOK_PATH;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function buildWebhookListenerPath(rawPath: string | undefined, rawToken: string | undefined): string {
  const basePath = normalizeWebhookPath(rawPath);
  const token = rawToken?.trim().replace(/^\/+|\/+$/g, "");
  if (!token) {
    return basePath;
  }
  return `${basePath}/${token}`;
}

export function parseAllowedSenders(rawValue: string | undefined): string[] {
  if (!rawValue) return [];
  return rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function sanitizeEventIdForFileName(rawEventId: string): string {
  return rawEventId.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function parseAgentMailWebhook(payload: unknown, rawBody: string): ParsedAgentMailWebhook | null {
  const root = asRecord(payload);
  if (!root) return null;

  const eventType = asString(root["event_type"]) ?? asString(root["eventType"]);
  if (!eventType) return null;

  const message = asRecord(root["message"]);
  const senderEmail = firstEmail(message?.["from"])?.toLowerCase();
  const subject = capText(asString(message?.["subject"]) ?? "(no subject)", SUBJECT_MAX_CHARS) ?? "(no subject)";
  const triggeredAt = asString(message?.["timestamp"])
    ?? asString(root["created_at"])
    ?? asString(root["createdAt"])
    ?? new Date().toISOString();
  const eventId = inferEventId(root, rawBody);
  const summary = senderEmail
    ? `Incoming email from ${senderEmail} with subject ${subject}`
    : `Incoming email with subject ${subject}`;

  const systemEvent: PluginSystemEventInput = {
    source: "agentmail",
    eventName: eventType,
    eventId,
    receivedAt: triggeredAt,
    summary,
    payload: root,
  };

  return {
    eventType,
    eventId,
    senderEmail,
    systemEvent,
  };
}
