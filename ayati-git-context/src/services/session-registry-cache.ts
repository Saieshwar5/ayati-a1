import type { SessionRef } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  readLiveSessionRecords,
  readSessionRecord,
  sessionRecordRef,
  type SessionRecord,
} from "../repositories/session-records.js";

export class SessionRegistryCache {
  private readonly bySessionId = new Map<string, SessionRecord>();
  private readonly liveByAgentId = new Map<string, string>();

  constructor(database: ContextDatabase) {
    for (const session of readLiveSessionRecords(database)) {
      this.set(session);
    }
  }

  getSession(database: ContextDatabase, sessionId: string): SessionRecord | undefined {
    const cached = this.bySessionId.get(sessionId);
    if (cached) return cached;
    const loaded = readSessionRecord(database, sessionId);
    if (loaded) this.set(loaded);
    return loaded;
  }

  getLiveSessionForAgent(agentId: string): SessionRecord | undefined {
    const sessionId = this.liveByAgentId.get(agentId);
    return sessionId ? this.bySessionId.get(sessionId) : undefined;
  }

  getLatestLiveSession(): SessionRecord | undefined {
    return [...this.liveByAgentId.values()]
      .map((sessionId) => this.bySessionId.get(sessionId))
      .filter((session): session is SessionRecord => Boolean(session))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  set(session: SessionRecord): void {
    const previous = this.bySessionId.get(session.sessionId);
    if (previous && isLive(previous) && previous.agentId !== session.agentId) {
      this.liveByAgentId.delete(previous.agentId);
    }
    this.bySessionId.set(session.sessionId, session);
    if (isLive(session)) {
      this.liveByAgentId.set(session.agentId, session.sessionId);
    } else if (this.liveByAgentId.get(session.agentId) === session.sessionId) {
      this.liveByAgentId.delete(session.agentId);
    }
  }

  updateHead(sessionId: string, head: string): SessionRecord {
    const session = this.require(sessionId);
    const updated = { ...session, head };
    this.set(updated);
    return updated;
  }

  updateStatus(
    sessionId: string,
    status: SessionRecord["status"],
    sealedAt?: string,
  ): SessionRecord {
    const session = this.require(sessionId);
    const updated: SessionRecord = {
      ...session,
      status,
      ...(sealedAt ? { sealedAt } : {}),
    };
    this.set(updated);
    return updated;
  }

  remove(sessionId: string): void {
    const session = this.bySessionId.get(sessionId);
    if (!session) return;
    this.bySessionId.delete(sessionId);
    if (this.liveByAgentId.get(session.agentId) === sessionId) {
      this.liveByAgentId.delete(session.agentId);
    }
  }

  clear(): void {
    this.bySessionId.clear();
    this.liveByAgentId.clear();
  }

  toRef(session: SessionRecord): SessionRef {
    return sessionRecordRef(session);
  }

  private require(sessionId: string): SessionRecord {
    const session = this.bySessionId.get(sessionId);
    if (!session) throw new Error("Session is not cached: " + sessionId);
    return session;
  }
}

function isLive(session: SessionRecord): boolean {
  return session.status === "open"
    || session.status === "rollover_pending"
    || session.status === "finalizing";
}
