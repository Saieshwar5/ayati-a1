export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  kind: "user" | "reply" | "feedback" | "notification" | "error";
  content: string;
  attachments?: ChatAttachment[];
  timestamp: number;
  streaming?: boolean;
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

export interface ChatRequestMessage {
  type: "chat";
  content: string;
  attachments?: ChatAttachment[];
  uiContext?: AgentUiContext;
}

export type WorkspaceEventName =
  | "workspace_session_started"
  | "workspace_session_ended"
  | "cli_input_started"
  | "cli_message_submitted";

export interface WorkspaceEventMessage {
  type: "workspace_event";
  event: WorkspaceEventName;
  workspaceSessionId: string;
  uiContext?: AgentUiContext;
}

export interface ClientHelloMessage {
  type: "client_hello";
  capabilities?: {
    replyStreaming?: boolean;
  };
}

export type ClientMessage = ChatRequestMessage | WorkspaceEventMessage | ClientHelloMessage;

export interface AgentUiContext {
  source: "agent-cli";
  terminalPid?: number;
  processPid?: number;
  processTreePids?: number[];
  windowAddress?: string;
  windowClass?: string;
  windowTitle?: string;
  workspaceId?: number;
  workspaceName?: string;
  monitor?: string;
  detectedAt?: string;
}

export interface ReplyMessage {
  type: "reply";
  content: string;
  runId?: string;
  artifacts?: unknown[];
}

export interface FeedbackMessage {
  type: "feedback";
  content: string;
}

export interface NotificationMessage {
  type: "notification";
  content: string;
  final?: boolean;
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
  commitStatus: "committed" | "skipped" | "failed";
  kind?: "reply" | "feedback" | "notification";
  runId?: string;
  artifacts?: unknown[];
}

export interface ErrorMessage {
  type: "error";
  content: string;
}

export type ServerMessage =
  | ReplyMessage
  | FeedbackMessage
  | NotificationMessage
  | ProgressMessage
  | ReplyStartedMessage
  | ReplyDeltaMessage
  | ReplyDoneMessage
  | ErrorMessage;
