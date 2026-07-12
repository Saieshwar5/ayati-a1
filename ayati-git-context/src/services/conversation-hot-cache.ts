import { createHash } from "node:crypto";
import type { ConversationContext, ConversationRef } from "../contracts.js";
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

  clear(): void {
    this.bySessionId.clear();
  }
}

function liveContentHash(context: ConversationContext): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(context.messages))
    .digest("hex");
}
