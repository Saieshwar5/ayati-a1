export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  kind: "user" | "reply" | "feedback" | "notification" | "error";
  content: string;
  attachments?: ChatAttachment[];
  timestamp: number;
  streaming?: boolean;
  runId?: string;
  commitStatus?: ReplyDoneMessage["commitStatus"];
};

export interface ChatAttachment {
  source?: "cli";
  path: string;
  name?: string;
  kind?: "file" | "directory";
  sizeBytes?: number;
  entryCount?: number;
}

export type ChatRequestAttachment =
  | {
    type?: "file";
    source: "cli";
    path: string;
    name?: string;
  }
  | {
    type: "directory";
    source: "cli";
    path: string;
    name?: string;
  };

export interface ChatRequestMessage {
  type: "chat";
  messageId: string;
  content: string;
  attachments?: ChatRequestAttachment[];
}

export interface ClientHelloMessage {
  type: "client_hello";
  clientKind?: "cli" | "desktop" | "voice";
  capabilities?: {
    replyStreaming?: boolean;
  };
}

export interface ChatAcceptedMessage {
  type: "chat_accepted";
  messageId: string;
  queued: boolean;
  queuePosition: number;
  duplicate?: true;
}

export interface ReplyRenderedMessage {
  type: "reply_rendered";
  turnId: string;
  renderedAt: string;
}

export type ClientMessage =
  | ChatRequestMessage
  | ClientHelloMessage
  | ReplyRenderedMessage;

export interface ReplyMessage {
  type: "reply";
  content: string;
  runId?: string;
  commitStatus: ReplyCommitStatus;
  artifacts?: unknown[];
}

export interface FeedbackMessage {
  type: "feedback";
  content: string;
  runId?: string;
  commitStatus: ReplyCommitStatus;
}

export interface NotificationMessage {
  type: "notification";
  content: string;
  final?: boolean;
  runId?: string;
  commitStatus: ReplyCommitStatus;
}

export interface ProgressMessage {
  type: "progress";
  content: string;
  runId?: string;
}

export interface ReplyStartedMessage {
  type: "reply_started";
  turnId: string;
  runId?: string;
  kind?: "reply" | "feedback" | "notification";
}

export interface ReplyDeltaMessage {
  type: "reply_delta";
  turnId: string;
  seq: number;
  delta: string;
}

export interface ReplyDoneMessage {
  type: "reply_done";
  turnId: string;
  content: string;
  commitStatus: ReplyCommitStatus;
  kind?: "reply" | "feedback" | "notification";
  runId?: string;
  artifacts?: unknown[];
}

export type ReplyCommitStatus = "not_required" | "no_change" | "committed" | "failed";

export interface ErrorMessage {
  type: "error";
  content: string;
}

export type ServerMessage =
  | ChatAcceptedMessage
  | ReplyMessage
  | FeedbackMessage
  | NotificationMessage
  | ProgressMessage
  | ReplyStartedMessage
  | ReplyDeltaMessage
  | ReplyDoneMessage
  | ErrorMessage;
