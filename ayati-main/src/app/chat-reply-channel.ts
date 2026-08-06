import type { ChatTurnRuntimeInput } from "../ivec/chat-turn-runtime.js";

export interface ChatReplyChannel {
  readonly clientId: string;
  readonly supportsStreaming: boolean;
  send(data: unknown): void;
}

export interface CreateChatReplyChannelOptions {
  input: ChatTurnRuntimeInput;
  onReply?: (clientId: string, data: unknown) => void;
  clientSupportsReplyStreaming: (clientId: string) => boolean;
}

export function createChatReplyChannel(
  options: CreateChatReplyChannelOptions,
): ChatReplyChannel {
  const clientId = options.input.replyClientId ?? options.input.clientId;
  const messageId = options.input.messageId;

  return {
    clientId,
    supportsStreaming: options.clientSupportsReplyStreaming(clientId),
    send: (data) => {
      options.onReply?.(clientId, withMessageId(data, messageId));
    },
  };
}

function withMessageId(data: unknown, messageId: string | undefined): unknown {
  if (!messageId || !data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  return {
    ...data,
    messageId,
  };
}
