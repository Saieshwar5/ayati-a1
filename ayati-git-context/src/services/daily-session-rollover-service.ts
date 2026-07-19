import { join } from "node:path";
import type { EnsureActiveSessionResponse } from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { runGit } from "../git/git-process.js";
import {
  hasPendingSessionWork,
  insertSession,
  readSessionRecord,
  updateSessionStatus,
  type SessionRecord,
} from "../repositories/session-records.js";
import { ConversationHotCache } from "./conversation-hot-cache.js";
import { GitContextServiceObservability } from "./service-observability.js";
import { SessionRegistryCache } from "./session-registry-cache.js";

export interface DailySessionRolloverInput {
  date: string;
  timezone: string;
  at: string;
}

export type DailySessionRolloverAction =
  | "reuse"
  | "mark_pending"
  | "seal_and_create";

export class DailySessionRolloverService {
  constructor(private readonly options: {
    database: ContextDatabase;
    dataRoot: string;
    sessionRegistry: SessionRegistryCache;
    conversationCache: ConversationHotCache;
    events: GitContextServiceObservability;
    invalidateContext: (reason: string, sessionId: string) => void;
  }) {}

  async reconcile(
    existing: SessionRecord,
    input: DailySessionRolloverInput,
  ): Promise<EnsureActiveSessionResponse> {
    const action = await this.assess(existing, input);
    if (action === "reuse") {
      return { session: this.options.sessionRegistry.toRef(existing), created: false };
    }
    return action === "mark_pending"
      ? this.markPending(existing, input)
      : this.sealAndCreate(existing, input);
  }

  /** Performs read-only rollover checks so turn acceptance can apply DB changes atomically. */
  async assess(
    existing: SessionRecord,
    input: DailySessionRolloverInput,
  ): Promise<DailySessionRolloverAction> {
    if (existing.date === input.date) return "reuse";
    this.verifyTimezone(existing, input);
    return await this.isReadyToSeal(existing) ? "seal_and_create" : "mark_pending";
  }

  private verifyTimezone(existing: SessionRecord, input: DailySessionRolloverInput): void {
    if (existing.timezone === input.timezone) return;
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Active session timezone does not match the requested timezone.",
      details: {
        sessionId: existing.sessionId,
        activeTimezone: existing.timezone,
        requestedTimezone: input.timezone,
      },
    });
  }

  private async isReadyToSeal(existing: SessionRecord): Promise<boolean> {
    if (existing.status === "finalizing"
      || hasPendingSessionWork(this.options.database, existing.sessionId)) {
      return false;
    }
    const status = await runGit(["status", "--porcelain"], {
      cwd: existing.repositoryPath,
    });
    return status.trim().length === 0;
  }

  private markPending(
    existing: SessionRecord,
    input: DailySessionRolloverInput,
  ): EnsureActiveSessionResponse {
    if (existing.status === "finalizing") {
      return { session: this.options.sessionRegistry.toRef(existing), created: false };
    }
    if (existing.status === "rollover_pending") {
      return { session: this.options.sessionRegistry.toRef(existing), created: false };
    }
    const pending = updateSessionStatus(
      this.options.database,
      existing.sessionId,
      "rollover_pending",
      input.at,
    );
    this.options.sessionRegistry.set(pending);
    this.options.invalidateContext("session_rollover_pending", pending.sessionId);
    this.options.events.emit({
      level: "info",
      event: "session_rollover_pending",
      sessionId: pending.sessionId,
      outcome: "succeeded",
      data: {
        activeDate: pending.date,
        requestedDate: input.date,
        reason: "waiting_for_task_bound_run_commit",
      },
    });
    return { session: this.options.sessionRegistry.toRef(pending), created: false };
  }

  private sealAndCreate(
    existing: SessionRecord,
    input: DailySessionRolloverInput,
  ): EnsureActiveSessionResponse {
    const sessionId = "S-" + input.date.replaceAll("-", "") + "-" + existing.agentId;
    this.options.database.transaction(() => {
      updateSessionStatus(this.options.database, existing.sessionId, "sealed", input.at);
      insertSession(this.options.database, {
        sessionId,
        date: input.date,
        timezone: input.timezone,
        agentId: existing.agentId,
        repositoryPath: join(this.options.dataRoot, "sessions", sessionId),
        previousSessionId: existing.sessionId,
        createdAt: input.at,
      });
    });
    const sealed = readSessionRecord(this.options.database, existing.sessionId);
    const next = readSessionRecord(this.options.database, sessionId);
    if (!sealed || !next) throw new Error("Daily session rollover did not persist both sessions.");
    this.options.sessionRegistry.set(sealed);
    this.options.sessionRegistry.set(next);
    this.options.conversationCache.refreshSession(this.options.database, existing.sessionId);
    this.options.invalidateContext("session_rollover_completed", next.sessionId);
    this.options.events.emit({
      level: "info",
      event: "session_rollover_completed",
      sessionId: next.sessionId,
      outcome: "succeeded",
      data: {
        previousSessionId: existing.sessionId,
        previousDate: existing.date,
        currentDate: next.date,
        previousHead: existing.head,
        closingCommitCreated: false,
      },
    });
    return { session: this.options.sessionRegistry.toRef(next), created: true };
  }
}

export function localDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
