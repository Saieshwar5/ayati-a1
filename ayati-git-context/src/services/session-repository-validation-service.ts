import type { SessionRef } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { ensureSessionRepository } from "../git/session-repository.js";
import { updateSessionHead } from "../repositories/session-records.js";
import { GitContextServiceObservability } from "./service-observability.js";
import { SessionRegistryCache } from "./session-registry-cache.js";
import { SessionSummaryHotCache } from "./session-summary-hot-cache.js";

export const DEFAULT_SESSION_REPOSITORY_VALIDATION_INTERVAL_MS = 5 * 60_000;

export type SessionRepositoryValidationReason = "startup" | "request" | "rollover" | "periodic";

interface SessionRepositoryValidationStamp {
  sessionId: string;
  repositoryPath: string;
  date: string;
  timezone: string;
  agentId: string;
  head: string | null;
  validatedAtMs: number;
}

export class SessionRepositoryValidationService {
  private readonly bySessionId = new Map<string, SessionRepositoryValidationStamp>();

  constructor(private readonly options: {
    database: ContextDatabase;
    sessionRegistry: SessionRegistryCache;
    sessionSummaryCache: SessionSummaryHotCache;
    events: GitContextServiceObservability;
    invalidateContext: (reason: string, sessionId: string) => void;
    maxAgeMs: number;
    now: () => string;
  }) {}

  async ensure(
    sessionId: string,
    reason: SessionRepositoryValidationReason,
  ): Promise<SessionRef> {
    const record = this.options.sessionRegistry.getSession(this.options.database, sessionId);
    if (!record) {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session does not exist.",
        details: { sessionId },
      });
    }
    const session = this.options.sessionRegistry.toRef(record);
    const reusable = this.reusable(session, record.agentId);
    if (reusable) {
      this.options.events.emit({
        level: "debug",
        event: "session_repository_validation_reused",
        sessionId,
        outcome: "succeeded",
        data: {
          reason,
          head: session.head,
          ageMs: reusable.ageMs,
          validatedAt: new Date(reusable.validatedAtMs).toISOString(),
        },
      });
      return session;
    }
    return await this.validate(session, record.agentId, record.createdAt, reason);
  }

  clear(): void {
    this.bySessionId.clear();
  }

  private async validate(
    session: SessionRef,
    agentId: string,
    createdAt: string,
    reason: SessionRepositoryValidationReason,
  ): Promise<SessionRef> {
    const startedAt = Date.now();
    this.options.events.emit({
      level: "debug",
      event: "session_repository_validation_started",
      sessionId: session.sessionId,
      outcome: "started",
      data: { reason, expectedHead: session.head },
    });
    let head: string;
    try {
      head = await ensureSessionRepository({ session, agentId, createdAt });
    } catch (error) {
      this.bySessionId.delete(session.sessionId);
      this.options.events.emit({
        level: "error",
        event: "session_repository_validation_failed",
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        data: { reason, expectedHead: session.head },
      });
      if (error instanceof GitContextServiceError) {
        throw error;
      }
      throw new GitContextServiceError({
        code: "REPOSITORY_UNAVAILABLE",
        message: "Session repository could not be initialized or recovered.",
        retryable: true,
        details: {
          sessionId: session.sessionId,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    if (session.head === head) {
      if (!this.options.sessionSummaryCache.get(session.sessionId, session.head)) {
        await this.options.sessionSummaryCache.refresh(session);
      }
      this.record(session, agentId);
      this.emitValidated(session, reason, startedAt, head, false);
      return session;
    }

    this.options.invalidateContext("session_head_changed", session.sessionId);
    const updated = updateSessionHead(this.options.database, session.sessionId, head);
    this.options.sessionRegistry.updateHead(session.sessionId, head);
    await this.options.sessionSummaryCache.refresh(updated);
    this.record(updated, agentId);
    this.emitValidated(updated, reason, startedAt, head, true, session.head);
    return updated;
  }

  private reusable(
    session: SessionRef,
    agentId: string,
  ): { ageMs: number; validatedAtMs: number } | undefined {
    const cached = this.bySessionId.get(session.sessionId);
    if (!cached || !sameRepositoryIdentity(cached, session, agentId)) {
      return undefined;
    }
    const ageMs = timestampMilliseconds(this.options.now()) - cached.validatedAtMs;
    if (ageMs < 0 || ageMs > this.options.maxAgeMs) {
      return undefined;
    }
    return { ageMs, validatedAtMs: cached.validatedAtMs };
  }

  private record(session: SessionRef, agentId: string): void {
    this.bySessionId.set(session.sessionId, {
      sessionId: session.sessionId,
      repositoryPath: session.repositoryPath,
      date: session.date,
      timezone: session.timezone,
      agentId,
      head: session.head,
      validatedAtMs: timestampMilliseconds(this.options.now()),
    });
  }

  private emitValidated(
    session: SessionRef,
    reason: SessionRepositoryValidationReason,
    startedAt: number,
    head: string,
    headChanged: boolean,
    previousHead?: string | null,
  ): void {
    this.options.events.emit({
      level: "info",
      event: "session_repository_validated",
      sessionId: session.sessionId,
      durationMs: Date.now() - startedAt,
      outcome: "succeeded",
      data: {
        reason,
        ...(previousHead ? { previousHead } : {}),
        head,
        headChanged,
      },
    });
  }
}

function sameRepositoryIdentity(
  cached: SessionRepositoryValidationStamp,
  session: SessionRef,
  agentId: string,
): boolean {
  return cached.sessionId === session.sessionId
    && cached.repositoryPath === session.repositoryPath
    && cached.date === session.date
    && cached.timezone === session.timezone
    && cached.agentId === agentId
    && cached.head === session.head;
}

function timestampMilliseconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
