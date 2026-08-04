import type { ChatAttachmentInput } from "./types.js";

export interface ChatTurnRuntimeInput {
  clientId: string;
  content: string;
  attachments: ChatAttachmentInput[];
}

export interface ChatTurnRuntime {
  processChat(input: ChatTurnRuntimeInput): Promise<void>;
  drain(): Promise<void>;
}
