import type { AssistantResponseKind, ConversationTurn } from "./types.js";

export function normalizeAssistantResponseKind(kind: ConversationTurn["assistantResponseKind"]): AssistantResponseKind {
  if (kind === "feedback" || kind === "notification") {
    return kind;
  }
  return "reply";
}

export function formatConversationTurnSpeaker(turn: ConversationTurn): string {
  if (turn.role === "user") {
    return "user";
  }
  return `assistant[${normalizeAssistantResponseKind(turn.assistantResponseKind)}]`;
}

export function formatConversationTurnInline(turn: ConversationTurn): string {
  return `${formatConversationTurnSpeaker(turn)}: ${turn.content}`;
}
