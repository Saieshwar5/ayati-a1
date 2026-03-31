import { create } from "zustand";
import {
  createChatMessageId,
  type ChatMessage,
  type ConnectionState,
  type ServerMessage,
} from "@/lib/chat/types";

interface ChatStoreState {
  connectionState: ConnectionState;
  messages: ChatMessage[];
  isAwaitingReply: boolean;
  errorMessage: string | null;
  markConnecting: () => void;
  markConnected: () => void;
  markDisconnected: (message?: string) => void;
  addUserMessage: (content: string, attachmentNames?: string[]) => void;
  addServerMessage: (message: ServerMessage) => void;
  clearError: () => void;
}

const ROLE_BY_SERVER_MESSAGE = {
  reply: "assistant",
  feedback: "assistant",
  notification: "system",
  error: "system",
} as const;

function buildServerChatMessage(message: ServerMessage): ChatMessage {
  return {
    id: createChatMessageId(message.type),
    role: ROLE_BY_SERVER_MESSAGE[message.type],
    kind: message.type,
    content: message.content,
    artifacts: message.artifacts,
    timestamp: Date.now(),
  };
}

export const useChatStore = create<ChatStoreState>()((set) => ({
  connectionState: "connecting",
  messages: [],
  isAwaitingReply: false,
  errorMessage: null,
  markConnecting: () => {
    set({
      connectionState: "connecting",
      errorMessage: null,
    });
  },
  markConnected: () => {
    set({
      connectionState: "connected",
      errorMessage: null,
    });
  },
  markDisconnected: (message) => {
    set({
      connectionState: "disconnected",
      errorMessage: message ?? null,
      isAwaitingReply: false,
    });
  },
  addUserMessage: (content, attachmentNames) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const attachmentSummary = attachmentNames && attachmentNames.length > 0
      ? `\n\nAttached: ${attachmentNames.join(", ")}`
      : "";

    set((state) => ({
      errorMessage: null,
      isAwaitingReply: true,
      messages: [
        ...state.messages,
        {
          id: createChatMessageId("user"),
          role: "user",
          kind: "user",
          content: `${trimmed}${attachmentSummary}`,
          timestamp: Date.now(),
        },
      ],
    }));
  },
  addServerMessage: (message) => {
    set((state) => ({
      errorMessage: message.type === "error" ? message.content : null,
      isAwaitingReply: false,
      messages: [...state.messages, buildServerChatMessage(message)],
    }));
  },
  clearError: () => {
    set({ errorMessage: null });
  },
}));
