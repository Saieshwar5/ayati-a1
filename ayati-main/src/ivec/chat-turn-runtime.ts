import type { AgentUiContext } from "../ui/context.js";
import type { ChatAttachmentInput } from "./types.js";

export interface ChatTurnRuntimeInput {
  clientId: string;
  content: string;
  attachments: ChatAttachmentInput[];
  uiContext?: AgentUiContext;
}

export interface ChatTurnRuntime {
  processChat(input: ChatTurnRuntimeInput): Promise<void>;
}
