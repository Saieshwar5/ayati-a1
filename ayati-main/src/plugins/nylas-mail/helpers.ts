import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { load as loadHtml } from "cheerio";
import type { PluginSystemEventInput } from "../../core/contracts/plugin.js";

const DEFAULT_WEBHOOK_PATH = "/webhooks/nylas-mail";
const SUBJECT_MAX_CHARS = 300;
const BODY_PREVIEW_MAX_CHARS = 1_500;

export interface NormalizedGrantProfile {
  email?: string;
  provider?: string;
}

export interface ParsedNylasNotification {
  eventName: string;
  eventId: string;
  source?: string;
  grantId?: string;
  applicationId?: string;
  messageId?: string;
  threadId?: string;
  webhookDeliveryAttempt?: number;
  truncated: boolean;
  metadataOnly: boolean;
  transformed: boolean;
  cleaned: boolean;
  message?: Record<string, unknown>;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  const direct = asString(value);
  if (!direct) {
    return undefined;
  }

  if (/^\d+$/.test(direct)) {
    return new Date(Number(direct) * 1000).toISOString();
  }

  return direct;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null);
}

function compactWhitespace(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (!/[<>]/.test(value)) {
    return compactWhitespace(value);
  }

  try {
    const $ = loadHtml(value);
    return compactWhitespace($.text());
  } catch {
    return compactWhitespace(value.replace(/<[^>]+>/g, " "));
  }
}

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...[truncated]`;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeParticipants(value: unknown): Array<{ email: string; name?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim().length > 0) {
      return [{ email: item.trim() }];
    }

    const record = asRecord(item);
    const email = asString(record?.["email"]);
    if (!email) {
      return [];
    }
    const name = asString(record?.["name"]);
    return [{ email, ...(name ? { name } : {}) }];
  });
}

function extractMessageRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (!direct) {
    return undefined;
  }

  const nestedData = asRecord(direct["data"]);
  const nestedObject = asRecord(nestedData?.["object"]);
  const nestedMessage = asRecord(direct["message"]);
  const objectData = asRecord(direct["object_data"]) ?? asRecord(direct["objectData"]);
  const candidate = nestedObject ?? nestedMessage ?? objectData ?? direct;
  const id = asString(candidate["id"]) ?? asString(candidate["message_id"]) ?? asString(candidate["messageId"]);
  const subject = asString(candidate["subject"]);
  const body = asString(candidate["body"]);
  const snippet = asString(candidate["snippet"]);
  if (id || subject || body || snippet || Array.isArray(candidate["from"])) {
    return candidate;
  }
  return undefined;
}

function inferEventId(candidate: Record<string, unknown>, rawBody: string): string {
  return asString(candidate["id"])
    ?? asString(candidate["event_id"])
    ?? asString(candidate["eventId"])
    ?? `hash:${createHash("sha256").update(rawBody).digest("hex").slice(0, 24)}`;
}

function normalizeSingleNotification(candidate: Record<string, unknown>, deliveryAttempt: number | undefined, rawBody: string): ParsedNylasNotification | null {
  const eventName = asString(candidate["type"]) ?? asString(candidate["event_type"]) ?? asString(candidate["eventType"]);
  if (!eventName) {
    return null;
  }

  const message = extractMessageRecord(candidate);
  const messageId = asString(message?.["id"]) ?? asString(message?.["message_id"]) ?? asString(message?.["messageId"]);
  const threadId = asString(message?.["thread_id"]) ?? asString(message?.["threadId"]);
  const grantId = asString(message?.["grant_id"])
    ?? asString(message?.["grantId"])
    ?? asString(candidate["grant_id"])
    ?? asString(candidate["grantId"]);
  const applicationId = asString(message?.["application_id"])
    ?? asString(message?.["applicationId"])
    ?? asString(candidate["application_id"])
    ?? asString(candidate["applicationId"]);

  return {
    eventName,
    eventId: inferEventId(candidate, rawBody),
    ...(asString(candidate["source"]) ? { source: asString(candidate["source"]) } : {}),
    ...(grantId ? { grantId } : {}),
    ...(applicationId ? { applicationId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(typeof deliveryAttempt === "number" ? { webhookDeliveryAttempt: deliveryAttempt } : {}),
    truncated: eventName.includes(".truncated"),
    metadataOnly: eventName.includes(".metadata"),
    transformed: eventName.includes(".transformed"),
    cleaned: eventName.includes(".cleaned"),
    ...(message ? { message } : {}),
  };
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

export function computeNylasSignature(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyNylasSignature(secret: string, rawBody: string, providedSignature: string | undefined): boolean {
  const signature = providedSignature?.trim();
  if (!signature) {
    return false;
  }

  const expected = Buffer.from(computeNylasSignature(secret, rawBody), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

export function parseNylasWebhookNotifications(payload: unknown, rawBody: string): ParsedNylasNotification[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const deliveryAttempt = asNumber(root["webhook_delivery_attempt"]) ?? asNumber(root["webhookDeliveryAttempt"]);
  const deltas = asRecordArray(root["deltas"]);
  if (deltas.length > 0) {
    return deltas
      .map((delta) => normalizeSingleNotification(delta, deliveryAttempt, rawBody))
      .filter((item): item is ParsedNylasNotification => item !== null);
  }

  const single = normalizeSingleNotification(root, deliveryAttempt, rawBody);
  return single ? [single] : [];
}

function extractPrimaryTimestamp(message: Record<string, unknown>, fallback: string | undefined): string {
  return normalizeTimestamp(message["received_at"])
    ?? normalizeTimestamp(message["receivedAt"])
    ?? normalizeTimestamp(message["received_date"])
    ?? normalizeTimestamp(message["receivedDate"])
    ?? normalizeTimestamp(message["date"])
    ?? normalizeTimestamp(message["sent_at"])
    ?? normalizeTimestamp(message["sentAt"])
    ?? fallback
    ?? new Date().toISOString();
}

function sanitizeMessagePayload(message: Record<string, unknown>, grantProfile?: NormalizedGrantProfile): Record<string, unknown> {
  const from = normalizeParticipants(message["from"]);
  const to = normalizeParticipants(message["to"]);
  const cc = normalizeParticipants(message["cc"]);
  const bcc = normalizeParticipants(message["bcc"]);
  const replyTo = normalizeParticipants(message["reply_to"] ?? message["replyTo"]);
  const folders = Array.isArray(message["folders"])
    ? message["folders"].flatMap((item) => asString(item) ?? [])
    : Array.isArray(message["labels"])
      ? (message["labels"] as unknown[]).flatMap((item) => asString(item) ?? [])
      : [];
  const attachments = Array.isArray(message["attachments"]) ? asRecordArray(message["attachments"]) : [];
  const subject = truncate(asString(message["subject"]) ?? "(no subject)", SUBJECT_MAX_CHARS) ?? "(no subject)";
  const snippet = compactWhitespace(asString(message["snippet"]));
  const bodyPreview = truncate(
    stripHtml(asString(message["body"]))
      ?? stripHtml(asString(message["cleaned_body"]))
      ?? stripHtml(asString(message["cleanedBody"]))
      ?? stripHtml(asString(message["conversation"]))
      ?? snippet,
    BODY_PREVIEW_MAX_CHARS,
  );
  const messageId = asString(message["id"]) ?? asString(message["message_id"]) ?? asString(message["messageId"]);
  const threadId = asString(message["thread_id"]) ?? asString(message["threadId"]);
  const grantId = asString(message["grant_id"]) ?? asString(message["grantId"]);
  const applicationId = asString(message["application_id"]) ?? asString(message["applicationId"]);
  const sentAt = normalizeTimestamp(message["date"]) ?? normalizeTimestamp(message["sent_at"]) ?? normalizeTimestamp(message["sentAt"]);
  const receivedAt = extractPrimaryTimestamp(message, sentAt);
  const sender = from[0];

  return {
    ...(messageId ? { messageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(grantId ? { grantId } : {}),
    ...(applicationId ? { applicationId } : {}),
    ...(grantProfile?.provider ? { provider: grantProfile.provider } : {}),
    ...(grantProfile?.email ? { mailboxEmail: grantProfile.email } : {}),
    subject,
    ...(sender ? { sender } : {}),
    ...(from.length > 0 ? { from } : {}),
    ...(to.length > 0 ? { to } : {}),
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(replyTo.length > 0 ? { replyTo } : {}),
    ...(sentAt ? { sentAt } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    ...(typeof asBoolean(message["unread"]) === "boolean" ? { unread: asBoolean(message["unread"]) } : {}),
    ...(typeof asBoolean(message["starred"]) === "boolean" ? { starred: asBoolean(message["starred"]) } : {}),
    ...(folders.length > 0 ? { folders } : {}),
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    ...(snippet ? { snippet } : {}),
    ...(bodyPreview ? { bodyPreview } : {}),
  };
}

export function buildSystemEventFromNylasNotification(
  notification: ParsedNylasNotification,
  hydratedMessage: Record<string, unknown> | undefined,
  grantProfile?: NormalizedGrantProfile,
): PluginSystemEventInput | null {
  const message = hydratedMessage ?? notification.message;
  if (!message) {
    return null;
  }

  const payload = sanitizeMessagePayload(message, grantProfile);
  const senderEmail = asString((payload["sender"] as Record<string, unknown> | undefined)?.["email"]);
  if (grantProfile?.email && senderEmail && grantProfile.email.toLowerCase() === senderEmail.toLowerCase()) {
    return null;
  }

  const subject = asString(payload["subject"]) ?? "(no subject)";
  const summary = senderEmail
    ? `Incoming email from ${senderEmail} with subject ${subject}`
    : `Incoming email with subject ${subject}`;
  const receivedAt = asString(payload["receivedAt"]) ?? new Date().toISOString();

  return {
    source: "nylas-mail",
    eventName: notification.eventName,
    eventId: notification.eventId,
    receivedAt,
    summary,
    intent: {
      kind: "task",
      eventClass: "message_received",
      trustTier: "external",
      effectLevel: "observe",
      requestedAction: "review_incoming_message",
      createdBy: "external",
    },
    payload: {
      notificationType: notification.eventName,
      webhookEventId: notification.eventId,
      ...(typeof notification.webhookDeliveryAttempt === "number" ? { webhookDeliveryAttempt: notification.webhookDeliveryAttempt } : {}),
      ...(notification.source ? { source: notification.source } : {}),
      ...(notification.grantId ?? payload["grantId"] ? { grantId: notification.grantId ?? payload["grantId"] } : {}),
      ...(notification.applicationId ?? payload["applicationId"] ? { applicationId: notification.applicationId ?? payload["applicationId"] } : {}),
      truncated: notification.truncated,
      metadataOnly: notification.metadataOnly,
      transformed: notification.transformed,
      cleaned: notification.cleaned,
      ...payload,
    },
  };
}

export function extractGrantProfile(payload: unknown): NormalizedGrantProfile {
  const root = asRecord(payload);
  const record = asRecord(root?.["data"]) ?? root ?? {};
  const settings = asRecord(record["settings"]);
  const identity = asRecord(record["identity"]);
  return {
    ...(asString(record["email"])
      ?? asString(record["grant_email"])
      ?? asString(settings?.["email"])
      ?? asString(identity?.["email"])
      ? {
        email: asString(record["email"])
          ?? asString(record["grant_email"])
          ?? asString(settings?.["email"])
          ?? asString(identity?.["email"]),
      }
      : {}),
    ...(asString(record["provider"]) ? { provider: asString(record["provider"]) } : {}),
  };
}
