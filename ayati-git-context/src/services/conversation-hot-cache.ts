import { createHash } from "node:crypto";
import type {
  ConversationContext,
  ConversationMessage,
  ConversationRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { readPendingConversationContexts } from "../repositories/conversation-records.js";
import { readLiveSessionRecords } from "../repositories/session-records.js";

export class ConversationHotCache {
  private readonly bySessionId = new Map<string, ConversationContext[]>();

  constructor(database: ContextDatabase) {
    for (const session of readLiveSessionRecords(database)) {
      this.refreshSession(database, session.sessionId);
    }
  }

  getPendingContexts(database: ContextDatabase, sessionId: string): ConversationContext[] {
    return this.bySessionId.get(sessionId) ?? this.refreshSession(database, sessionId);
  }

  getPendingConversations(database: ContextDatabase, sessionId: string): ConversationRef[] {
    return this.getPendingContexts(database, sessionId).map((item) => item.conversation);
  }

  refreshSession(database: ContextDatabase, sessionId: string): ConversationContext[] {
    const contexts = readPendingConversationContexts(database, sessionId).map((context) => ({
      ...context,
      contentHash: context.contentHash || liveContentHash(context),
    }));
    this.bySessionId.set(sessionId, contexts);
    return contexts;
  }

  append(
    sessionId: string,
    conversation: ConversationRef,
    message: ConversationMessage,
  ): ConversationContext[] {
    const contexts = this.bySessionId.get(sessionId);
    if (!contexts) {
      return [];
    }
    const currentContexts = message.role === "assistant"
      ? contexts
      : contexts.map((item) => item.conversation.status === "active"
        ? {
            ...item,
            conversation: {
              ...item.conversation,
              status: "closed" as const,
              filePath: "conversations/"
                + String(item.conversation.sequence).padStart(6, "0")
                + "-session.md",
            },
          }
        : item);
    const existingIndex = currentContexts.findIndex((item) =>
      item.conversation.conversationId === conversation.conversationId
    );
    const next = [...currentContexts];
    const context: ConversationContext = existingIndex >= 0
      ? {
          conversation,
          messages: [...currentContexts[existingIndex]!.messages, message],
          contentHash: "",
        }
      : {
          conversation,
          messages: [message],
          contentHash: "",
        };
    context.contentHash = liveContentHash(context);
    if (existingIndex >= 0) {
      next[existingIndex] = context;
    } else {
      next.push(context);
    }
    this.bySessionId.set(sessionId, next);
    return next;
  }

  clear(): void {
    this.bySessionId.clear();
  }
}

function liveContentHash(context: ConversationContext): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(context.messages))
    .digest("hex");
}
