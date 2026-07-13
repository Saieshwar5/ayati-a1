import { createHash } from "node:crypto";
import type {
  ActiveContext,
  ConversationContext,
  RunContextProjection,
} from "../contracts.js";

export class ActiveContextCache {
  private readonly entries = new Map<string, ActiveContext>();

  get(sessionId: string, revision: string): ActiveContext | undefined {
    return this.entries.get(sessionId + ":" + revision);
  }

  set(sessionId: string, revision: string, context: ActiveContext): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(sessionId + ":")) {
        this.entries.delete(key);
      }
    }
    this.entries.set(sessionId + ":" + revision, context);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function activeContextRevision(input: {
  head: string | null;
  status: string;
  conversations: ConversationContext[];
  run?: RunContextProjection;
}): { revision: string; pendingDigest: string } {
  const pendingDigest = hash(JSON.stringify(input.conversations.map((item) => ({
    id: item.conversation.conversationId,
    path: item.conversation.filePath,
    status: item.conversation.status,
    hash: item.contentHash,
  }))));
  const revision = hash(JSON.stringify({
    head: input.head,
    status: input.status,
    pendingDigest,
    run: input.run ?? null,
  }));
  return { revision, pendingDigest };
}

function hash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
