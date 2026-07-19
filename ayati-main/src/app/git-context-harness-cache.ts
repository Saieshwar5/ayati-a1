import { createHash } from "node:crypto";
import type {
  ActiveContext,
  ConversationMessage,
  ConversationRef,
  ReadContextProjection,
  RunContextProjection,
} from "ayati-git-context";
import {
  buildContextEngineProjection,
  type ContextEngineMachineContext,
} from "../context-engine/index.js";

interface HarnessContextCacheEntry {
  revision: string;
  active: ActiveContext;
  projection: ContextEngineMachineContext;
}

export interface GitContextHarnessCacheStats {
  hits: number;
  misses: number;
  refreshes: number;
  incrementalUpdates: number;
  dirtyTransitions: number;
  revision?: string;
  dirty: boolean;
}

interface MutableCacheStats {
  hits: number;
  misses: number;
  refreshes: number;
  incrementalUpdates: number;
  dirtyTransitions: number;
}

/**
 * Disposable, agent-ready mirror of authoritative Git Context Engine state.
 * Durable writes and revision creation always remain service responsibilities.
 */
export class GitContextHarnessCache {
  private readonly bySessionId = new Map<string, HarnessContextCacheEntry>();
  private readonly dirtySessions = new Set<string>();
  private readonly statsBySessionId = new Map<string, MutableCacheStats>();

  getProjection(sessionId: string): ContextEngineMachineContext | undefined {
    const value = this.dirtySessions.has(sessionId)
      ? undefined
      : this.bySessionId.get(sessionId)?.projection;
    value ? this.stats(sessionId).hits++ : this.stats(sessionId).misses++;
    return value;
  }

  getActive(sessionId: string): ActiveContext | undefined {
    return this.dirtySessions.has(sessionId)
      ? undefined
      : this.bySessionId.get(sessionId)?.active;
  }

  set(sessionId: string, active: ActiveContext): ContextEngineMachineContext {
    const existing = this.bySessionId.get(sessionId);
    if (existing?.revision === active.contextRevision) {
      this.dirtySessions.delete(sessionId);
      return existing.projection;
    }
    const projection = buildContextEngineProjection(active);
    this.bySessionId.set(sessionId, {
      revision: active.contextRevision,
      active,
      projection,
    });
    this.dirtySessions.delete(sessionId);
    this.stats(sessionId).refreshes++;
    return projection;
  }

  appendConversation(input: {
    sessionId: string;
    conversation: ConversationRef;
    message: ConversationMessage;
    contextRevision: string;
    pendingDigest: string;
  }): ContextEngineMachineContext | undefined {
    if (this.dirtySessions.has(input.sessionId)) {
      return undefined;
    }
    const existing = this.bySessionId.get(input.sessionId);
    if (!existing?.active.session) {
      return undefined;
    }
    const contexts = input.message.role === "assistant"
      ? existing.active.session.pendingConversationContext
      : existing.active.session.pendingConversationContext.map((item) =>
        item.conversation.status === "active"
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
          : item
      );
    const contextIndex = contexts.findIndex((item) =>
      item.conversation.conversationId === input.conversation.conversationId
    );
    const nextContexts = [...contexts];
    if (contextIndex >= 0) {
      const current = contexts[contextIndex]!;
      nextContexts[contextIndex] = {
        ...current,
        conversation: input.conversation,
        messages: [...current.messages, input.message],
        contentHash: conversationContentHash([...current.messages, input.message]),
      };
    } else {
      nextContexts.push({
        conversation: input.conversation,
        messages: [input.message],
        contentHash: conversationContentHash([input.message]),
      });
    }
    const active: ActiveContext = {
      ...existing.active,
      contextRevision: input.contextRevision,
      session: {
        ...existing.active.session,
        pendingConversation: nextContexts.map((item) => item.conversation),
        pendingConversationContext: nextContexts,
        pendingDigest: input.pendingDigest,
      },
    };
    const projection = buildContextEngineProjection(active);
    this.bySessionId.set(input.sessionId, {
      revision: input.contextRevision,
      active,
      projection,
    });
    this.stats(input.sessionId).incrementalUpdates++;
    return projection;
  }

  updateRun(input: {
    sessionId: string;
    run: RunContextProjection;
    readContext: ReadContextProjection;
    baseProjection?: ContextEngineMachineContext;
  }): ContextEngineMachineContext | undefined {
    if (this.dirtySessions.has(input.sessionId)) return undefined;
    const existing = this.bySessionId.get(input.sessionId);
    if (!existing) return undefined;
    const revision = "run:" + createHash("sha256")
      .update(JSON.stringify({
        runId: input.run.run.runId,
        stepCount: input.run.run.stepCount,
        workStateRevision: input.run.workState.revision,
        readContextRevision: input.readContext.revision,
      }))
      .digest("hex");
    const active: ActiveContext = {
      ...existing.active,
      contextRevision: revision,
      run: input.run,
      readContext: input.readContext,
    };
    const projection: ContextEngineMachineContext = {
      ...(input.baseProjection ?? existing.projection),
      readContext: input.readContext,
    };
    this.bySessionId.set(input.sessionId, { revision, active, projection });
    this.stats(input.sessionId).incrementalUpdates++;
    return projection;
  }

  markDirty(sessionId: string): void {
    if (this.bySessionId.has(sessionId) && !this.dirtySessions.has(sessionId)) {
      this.dirtySessions.add(sessionId);
      this.stats(sessionId).dirtyTransitions++;
    }
  }

  getStats(sessionId: string): GitContextHarnessCacheStats {
    const stats = this.stats(sessionId);
    return {
      ...stats,
      ...(this.bySessionId.get(sessionId)?.revision
        ? { revision: this.bySessionId.get(sessionId)!.revision }
        : {}),
      dirty: this.dirtySessions.has(sessionId),
    };
  }

  remove(sessionId: string): void {
    this.bySessionId.delete(sessionId);
    this.dirtySessions.delete(sessionId);
    this.statsBySessionId.delete(sessionId);
  }

  clear(): void {
    this.bySessionId.clear();
    this.dirtySessions.clear();
    this.statsBySessionId.clear();
  }

  private stats(sessionId: string): MutableCacheStats {
    const existing = this.statsBySessionId.get(sessionId);
    if (existing) return existing;
    const created = {
      hits: 0,
      misses: 0,
      refreshes: 0,
      incrementalUpdates: 0,
      dirtyTransitions: 0,
    };
    this.statsBySessionId.set(sessionId, created);
    return created;
  }
}

function conversationContentHash(messages: ConversationMessage[]): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex");
}
