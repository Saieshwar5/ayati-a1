import { createHash } from "node:crypto";
import type {
  ConversationContext,
  ConversationMessage,
  ConversationRef,
} from "../contracts.js";

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

export function renderWorkstreamConversationWindow(input: {
  workstreamId: string;
  runId: string;
  previousSessionHead: string;
  conversations: ConversationContext[];
}): string {
  const first = input.conversations.at(0)?.conversation.sequence;
  const last = input.conversations.at(-1)?.conversation.sequence;
  return [
    "# Workstream Conversation Window",
    "",
    "Workstream-Id: " + input.workstreamId,
    "Run: " + input.runId,
    "Previous-Session-Head: " + input.previousSessionHead,
    "Conversation-Range: " + (first ?? "unknown") + "-" + (last ?? "unknown"),
    "",
    ...input.conversations.flatMap((context) => [
      renderConversation(context.conversation, context.messages).trimEnd(),
      "",
    ]),
  ].join("\n");
}

function roleTitle(role: ConversationMessage["role"]): string {
  if (role === "system_event") {
    return "System Event";
  }
  return role[0]?.toUpperCase() + role.slice(1);
}
