export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export interface ChatAttachment {
  path: string;
  name?: string;
}

export interface ChatRequestMessage {
  type: "chat";
  content: string;
  attachments?: ChatAttachment[];
}

export interface ReplyMessage {
  type: "reply";
  content: string;
}

export interface ErrorMessage {
  type: "error";
  content: string;
}

export type ServerMessage = ReplyMessage | ErrorMessage;
