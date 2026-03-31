export type ConnectionState = "connecting" | "connected" | "disconnected";
export type FeedbackKind = "approval" | "confirmation" | "clarification";
export type ServerMessageType = "reply" | "feedback" | "notification" | "error";
export type ChatMessageKind = "user" | ServerMessageType;
export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatArtifact {
  kind: "image";
  name: string;
  urlPath: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  content: string;
  artifacts?: ChatArtifact[];
  timestamp: number;
}

export interface CliChatAttachment {
  source?: "cli";
  path: string;
  name?: string;
}

export interface WebChatAttachment {
  source: "web";
  uploadedPath: string;
  originalName: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type ChatRequestAttachment = CliChatAttachment | WebChatAttachment;

export interface ChatRequestMessage {
  type: "chat";
  content: string;
  attachments?: ChatRequestAttachment[];
}

export interface UploadResponse {
  uploadId: string;
  uploadedPath: string;
  originalName: string;
  mimeType?: string;
  sizeBytes: number;
}

interface BaseServerMessage {
  content: string;
  artifacts?: ChatArtifact[];
  runId?: string;
  sessionId?: string;
}

export interface ReplyMessage extends BaseServerMessage {
  type: "reply";
}

export interface FeedbackMessage extends BaseServerMessage {
  type: "feedback";
  feedbackId?: string;
  kind?: FeedbackKind;
  shortLabel?: string;
}

export interface NotificationMessage extends BaseServerMessage {
  type: "notification";
  source?: string;
  event?: string;
  eventId?: string;
}

export interface ErrorMessage extends BaseServerMessage {
  type: "error";
}

export type ServerMessage =
  | ReplyMessage
  | FeedbackMessage
  | NotificationMessage
  | ErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function parseArtifacts(value: unknown): ChatArtifact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const artifacts = value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (
      record["kind"] !== "image"
      || typeof record["name"] !== "string"
      || typeof record["urlPath"] !== "string"
    ) {
      return [];
    }

    return [{
      kind: "image" as const,
      name: record["name"],
      urlPath: record["urlPath"],
      mimeType: typeof record["mimeType"] === "string" ? record["mimeType"] : undefined,
      sizeBytes: typeof record["sizeBytes"] === "number" ? record["sizeBytes"] : undefined,
    }];
  });

  return artifacts.length > 0 ? artifacts : undefined;
}

export function parseServerMessage(input: unknown): ServerMessage | null {
  if (!isRecord(input)) {
    return null;
  }

  const type = readOptionalString(input, "type");
  const content = readOptionalString(input, "content");

  if (!type || !content) {
    return null;
  }

  if (type === "reply") {
    return {
      type,
      content,
      artifacts: parseArtifacts(input["artifacts"]),
      runId: readOptionalString(input, "runId"),
      sessionId: readOptionalString(input, "sessionId"),
    };
  }

  if (type === "feedback") {
    const kind = readOptionalString(input, "kind");

    return {
      type,
      content,
      artifacts: parseArtifacts(input["artifacts"]),
      feedbackId: readOptionalString(input, "feedbackId"),
      kind: kind === "approval" || kind === "confirmation" || kind === "clarification"
        ? kind
        : undefined,
      runId: readOptionalString(input, "runId"),
      sessionId: readOptionalString(input, "sessionId"),
      shortLabel: readOptionalString(input, "shortLabel"),
    };
  }

  if (type === "notification") {
    return {
      type,
      content,
      artifacts: parseArtifacts(input["artifacts"]),
      event: readOptionalString(input, "event"),
      eventId: readOptionalString(input, "eventId"),
      runId: readOptionalString(input, "runId"),
      sessionId: readOptionalString(input, "sessionId"),
      source: readOptionalString(input, "source"),
    };
  }

  if (type === "error") {
    return {
      type,
      content,
      artifacts: parseArtifacts(input["artifacts"]),
      runId: readOptionalString(input, "runId"),
      sessionId: readOptionalString(input, "sessionId"),
    };
  }

  return null;
}

export function createChatMessageId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
