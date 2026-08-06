export const MAX_CHAT_CONTENT_CHARS = 100_000;

export type DaemonConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export interface DaemonConnectionState {
  status: DaemonConnectionStatus;
  changedAt: string;
  detail?: string;
  retryInMs?: number;
}

export type ReplyCommitStatus =
  | "not_required"
  | "no_change"
  | "committed"
  | "failed";

export type AssistantMessageKind = "reply" | "feedback" | "notification";

export interface ChatAcceptedMessage {
  type: "chat_accepted";
  messageId: string;
  queued: boolean;
  queuePosition: number;
  duplicate?: true;
}

export interface ReplyStartedMessage {
  type: "reply_started";
  turnId: string;
  messageId?: string;
  runId?: string;
  kind?: AssistantMessageKind;
}

export interface ReplyDeltaMessage {
  type: "reply_delta";
  turnId: string;
  messageId?: string;
  seq: number;
  delta: string;
}

export interface ReplyDoneMessage {
  type: "reply_done";
  turnId: string;
  messageId?: string;
  content: string;
  commitStatus?: ReplyCommitStatus;
  kind?: AssistantMessageKind;
  runId?: string;
  artifacts?: unknown[];
}

export interface ContentMessage {
  type: "reply" | "feedback" | "notification" | "progress" | "error";
  messageId?: string;
  content: string;
  final?: boolean;
  runId?: string;
  commitStatus?: ReplyCommitStatus;
  artifacts?: unknown[];
}

export type DaemonServerMessage =
  | ChatAcceptedMessage
  | ReplyStartedMessage
  | ReplyDeltaMessage
  | ReplyDoneMessage
  | ContentMessage;

export type DesktopEvent =
  | {
    type: "connection_state";
    state: DaemonConnectionState;
  }
  | {
    type: "server_message";
    message: DaemonServerMessage;
  };

export interface SendChatInput {
  content: string;
}

export interface SendChatReceipt {
  messageId: string;
  submittedAt: string;
}

export interface ReplyRenderedInput {
  turnId: string;
  renderedAt: string;
}

export interface AyatiDesktopApi {
  getConnectionState(): Promise<DaemonConnectionState>;
  sendChat(input: SendChatInput): Promise<SendChatReceipt>;
  acknowledgeReplyRendered(input: ReplyRenderedInput): Promise<void>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

export function parseSendChatInput(value: unknown): SendChatInput | null {
  const record = asRecord(value);
  if (!record || typeof record["content"] !== "string") {
    return null;
  }
  const content = record["content"].trim();
  if (content.length === 0 || content.length > MAX_CHAT_CONTENT_CHARS) {
    return null;
  }
  return { content };
}

export function parseReplyRenderedInput(value: unknown): ReplyRenderedInput | null {
  const record = asRecord(value);
  const turnId = boundedString(record?.["turnId"], 128);
  const renderedAt = boundedString(record?.["renderedAt"], 64);
  if (!turnId || !renderedAt || !Number.isFinite(Date.parse(renderedAt))) {
    return null;
  }
  return { turnId, renderedAt };
}

export function parseDaemonServerMessage(value: unknown): DaemonServerMessage | null {
  const record = asRecord(value);
  const type = record?.["type"];
  if (!record || typeof type !== "string") {
    return null;
  }

  if (type === "chat_accepted") {
    const messageId = boundedString(record["messageId"], 128);
    const queuePosition = nonNegativeInteger(record["queuePosition"]);
    if (!messageId || typeof record["queued"] !== "boolean" || queuePosition === undefined) {
      return null;
    }
    return {
      type,
      messageId,
      queued: record["queued"],
      queuePosition,
      ...(record["duplicate"] === true ? { duplicate: true as const } : {}),
    };
  }

  if (type === "reply_started") {
    const turnId = boundedString(record["turnId"], 128);
    if (!turnId) return null;
    return {
      type,
      turnId,
      ...commonMessageMetadata(record),
      ...(assistantKind(record["kind"]) ? { kind: assistantKind(record["kind"]) } : {}),
    };
  }

  if (type === "reply_delta") {
    const turnId = boundedString(record["turnId"], 128);
    const seq = nonNegativeInteger(record["seq"]);
    if (!turnId || seq === undefined || typeof record["delta"] !== "string") {
      return null;
    }
    return {
      type,
      turnId,
      seq,
      delta: record["delta"],
      ...commonMessageMetadata(record),
    };
  }

  if (type === "reply_done") {
    const turnId = boundedString(record["turnId"], 128);
    if (!turnId || typeof record["content"] !== "string") {
      return null;
    }
    const kind = assistantKind(record["kind"]);
    const commitStatus = replyCommitStatus(record["commitStatus"]);
    return {
      type,
      turnId,
      content: record["content"],
      ...commonMessageMetadata(record),
      ...(kind ? { kind } : {}),
      ...(commitStatus ? { commitStatus } : {}),
      ...(Array.isArray(record["artifacts"]) ? { artifacts: record["artifacts"] } : {}),
    };
  }

  if (
    type === "reply"
    || type === "feedback"
    || type === "notification"
    || type === "progress"
    || type === "error"
  ) {
    if (typeof record["content"] !== "string") {
      return null;
    }
    const commitStatus = replyCommitStatus(record["commitStatus"]);
    return {
      type,
      content: record["content"],
      ...commonMessageMetadata(record),
      ...(record["final"] === true ? { final: true } : {}),
      ...(commitStatus ? { commitStatus } : {}),
      ...(Array.isArray(record["artifacts"]) ? { artifacts: record["artifacts"] } : {}),
    };
  }

  return null;
}

function commonMessageMetadata(record: Record<string, unknown>): {
  messageId?: string;
  runId?: string;
} {
  const messageId = boundedString(record["messageId"], 128);
  const runId = boundedString(record["runId"], 128);
  return {
    ...(messageId ? { messageId } : {}),
    ...(runId ? { runId } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function assistantKind(value: unknown): AssistantMessageKind | undefined {
  return value === "reply" || value === "feedback" || value === "notification"
    ? value
    : undefined;
}

function replyCommitStatus(value: unknown): ReplyCommitStatus | undefined {
  return value === "not_required"
    || value === "no_change"
    || value === "committed"
    || value === "failed"
    ? value
    : undefined;
}
