import type {
  AssistantMessageKind,
  DaemonServerMessage,
  ReplyCommitStatus,
  SendChatReceipt,
} from "../shared/contracts.js";

const MAX_PROGRESS_LINES = 8;

export interface ChatViewMessage {
  id: string;
  role: "user" | "assistant";
  kind: "user" | AssistantMessageKind | "error";
  content: string;
  timestamp: string;
  streaming?: boolean;
  runId?: string;
  commitStatus?: ReplyCommitStatus;
}

export interface ChatUiState {
  messages: ChatViewMessage[];
  progressLines: string[];
  queuePosition?: number;
  isAgentActive: boolean;
  nextLocalId: number;
}

export type ChatUiAction =
  | {
    type: "chat_submitted";
    content: string;
    receipt: SendChatReceipt;
  }
  | {
    type: "server_message";
    message: DaemonServerMessage;
    receivedAt: string;
  }
  | {
    type: "submission_failed";
    message: string;
    receivedAt: string;
  };

export const initialChatState: ChatUiState = {
  messages: [],
  progressLines: [],
  isAgentActive: false,
  nextLocalId: 1,
};

export function reduceChatState(state: ChatUiState, action: ChatUiAction): ChatUiState {
  if (action.type === "chat_submitted") {
    return {
      ...state,
      messages: [...state.messages, {
        id: `user:${action.receipt.messageId}`,
        role: "user",
        kind: "user",
        content: action.content,
        timestamp: action.receipt.submittedAt,
      }],
      isAgentActive: true,
      progressLines: [],
    };
  }

  if (action.type === "submission_failed") {
    return appendAssistantMessage(state, {
      kind: "error",
      content: action.message,
      timestamp: action.receivedAt,
    });
  }

  const message = action.message;
  if (message.type === "chat_accepted") {
    return {
      ...state,
      queuePosition: message.queued ? message.queuePosition : undefined,
      isAgentActive: true,
    };
  }

  if (message.type === "progress") {
    return {
      ...state,
      progressLines: [...state.progressLines, message.content].slice(-MAX_PROGRESS_LINES),
      isAgentActive: true,
      queuePosition: undefined,
    };
  }

  if (message.type === "reply_started") {
    const existing = state.messages.some((entry) => entry.id === `turn:${message.turnId}`);
    if (existing) return state;
    return {
      ...state,
      messages: [...state.messages, {
        id: `turn:${message.turnId}`,
        role: "assistant",
        kind: message.kind ?? "reply",
        content: "",
        timestamp: action.receivedAt,
        streaming: true,
        ...(message.runId ? { runId: message.runId } : {}),
      }],
      isAgentActive: true,
      queuePosition: undefined,
    };
  }

  if (message.type === "reply_delta") {
    const messageId = `turn:${message.turnId}`;
    const existing = state.messages.some((entry) => entry.id === messageId);
    const messages = existing
      ? state.messages.map((entry) => entry.id === messageId
        ? { ...entry, content: `${entry.content}${message.delta}`, streaming: true }
        : entry)
      : [...state.messages, {
        id: messageId,
        role: "assistant" as const,
        kind: "reply" as const,
        content: message.delta,
        timestamp: action.receivedAt,
        streaming: true,
      }];
    return {
      ...state,
      messages,
      isAgentActive: true,
      queuePosition: undefined,
    };
  }

  if (message.type === "reply_done") {
    const messageId = `turn:${message.turnId}`;
    const existing = state.messages.some((entry) => entry.id === messageId);
    const finalized: ChatViewMessage = {
      id: messageId,
      role: "assistant",
      kind: message.kind ?? "reply",
      content: message.content,
      timestamp: action.receivedAt,
      streaming: false,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.commitStatus ? { commitStatus: message.commitStatus } : {}),
    };
    return {
      ...state,
      messages: existing
        ? state.messages.map((entry) => entry.id === messageId
          ? { ...entry, ...finalized, timestamp: entry.timestamp }
          : entry)
        : [...state.messages, finalized],
      progressLines: [],
      queuePosition: undefined,
      isAgentActive: false,
    };
  }

  if (message.type === "reply" || message.type === "feedback" || message.type === "error") {
    return appendAssistantMessage({
      ...state,
      progressLines: [],
      queuePosition: undefined,
      isAgentActive: false,
    }, {
      kind: message.type,
      content: message.content,
      timestamp: action.receivedAt,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.commitStatus ? { commitStatus: message.commitStatus } : {}),
    });
  }

  if (message.type === "notification") {
    return appendAssistantMessage({
      ...state,
      ...(message.final === true
        ? { progressLines: [], queuePosition: undefined, isAgentActive: false }
        : {}),
    }, {
      kind: "notification",
      content: message.content,
      timestamp: action.receivedAt,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.commitStatus ? { commitStatus: message.commitStatus } : {}),
    });
  }

  return state;
}

function appendAssistantMessage(
  state: ChatUiState,
  message: Omit<ChatViewMessage, "id" | "role">,
): ChatUiState {
  return {
    ...state,
    nextLocalId: state.nextLocalId + 1,
    messages: [...state.messages, {
      id: `assistant:${state.nextLocalId}`,
      role: "assistant",
      ...message,
    }],
  };
}
