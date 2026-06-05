export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  kind: "user" | "reply" | "feedback" | "notification" | "error";
  content: string;
  attachments?: ChatAttachment[];
  timestamp: number;
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

export interface ErrorMessage {
  type: "error";
  content: string;
}

export type ServerMessage =
  | ReplyMessage
  | FeedbackMessage
  | NotificationMessage
  | ErrorMessage;
