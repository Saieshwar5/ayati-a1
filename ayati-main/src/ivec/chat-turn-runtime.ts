import type { ChatAttachmentInput } from "./types.js";

export interface ChatTurnRuntimeInput {
  clientId: string;
  replyClientId?: string;
  messageId?: string;
  channel?: "cli" | "desktop" | "voice" | "unknown";
  content: string;
  attachments: ChatAttachmentInput[];
}

export interface ChatTurnRuntime {
  processChat(input: ChatTurnRuntimeInput): Promise<void>;
}
