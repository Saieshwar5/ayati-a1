import { createHash } from "node:crypto";
import type { ConversationMessage, ConversationRef } from "../contracts.js";

export function renderConversation(
  conversation: ConversationRef,
  messages: ConversationMessage[],
): string {
  const startedAt = messages[0]?.at ?? "unknown";
  const sections = messages.map((message) => [
    "## " + roleTitle(message.role),
    "",
    message.content,
  ].join("\n"));
  return [
    "# Conversation " + String(conversation.sequence).padStart(6, "0"),
    "",
    "Conversation-Id: " + conversation.conversationId,
    "Started-At: " + startedAt,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

export function conversationContentHash(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function roleTitle(role: ConversationMessage["role"]): string {
  if (role === "system_event") {
    return "System Event";
  }
  return role[0]?.toUpperCase() + role.slice(1);
}
