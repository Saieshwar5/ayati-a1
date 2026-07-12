import { join } from "node:path";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type ActiveContext,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type GetActiveContextRequest,
  type HealthResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type SessionRef,
  type StartRunRequest,
  type StartRunResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent } from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  appendConversationMessage,
  readPendingConversations,
} from "../repositories/conversation-records.js";
import {
  readActiveRun,
  readRecentRunSteps,
  recordRunStep,
  startSessionRun,
} from "../repositories/run-records.js";
import {
  insertSession,
  readLatestLiveSession,
  readLatestSealedSessionId,
  readLiveSessionForAgent,
  readSession,
} from "../repositories/session-records.js";
import type { GitContextService } from "../service.js";
import { SerializedWriteQueue } from "../write-queue.js";

export interface SqliteGitContextServiceOptions {
  database: ContextDatabase;
  dataRoot: string;
  now?: () => string;
}

export class SqliteGitContextService implements GitContextService {
  private readonly database: ContextDatabase;
  private readonly dataRoot: string;
  private readonly now: () => string;
  private readonly queue = new SerializedWriteQueue();
  private closed = false;

  constructor(options: SqliteGitContextServiceOptions) {
    this.database = options.database;
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getHealth(): Promise<HealthResponse> {
    return await this.queue.enqueue(() => {
      const schemaReady = this.database.schemaVersion() === this.database.expectedSchemaVersion();
      return {
        service: "ayati-git-context",
        protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
        status: schemaReady ? "ok" : "degraded",
        ready: schemaReady,
        capabilities: [
          "health",
          "active_context",
          "sessions",
          "conversations",
          "runs",
        ],
      };
    });
  }

  async getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext> {
    return await this.queue.enqueue(() => {
      const session = input.sessionId
        ? readSession(this.database, input.sessionId)
        : readLatestLiveSession(this.database);
      if (!session) {
        return {
          session: null,
          warnings: [],
        };
      }
      const run = readActiveRun(this.database, session.sessionId);
      return {
        session: {
          session,
          summary: "",
          pendingConversation: readPendingConversations(this.database, session.sessionId),
          recentCommits: [],
        },
        ...(run
          ? {
              run: {
                run,
                recentToolCalls: readRecentRunSteps(this.database, run.runId),
              },
            }
          : {}),
        warnings: [],
      };
    });
  }

  async ensureActiveSession(
    input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    return await this.queue.enqueue(() => {
      const now = input.at ?? this.now();
      return executeIdempotent({
        database: this.database,
        requestId: input.requestId,
        operation: "ensure_active_session",
        payload: input,
        now,
        execute: () => this.ensureSession(input, now),
      });
    });
  }

  async appendConversation(
    input: AppendConversationRequest,
  ): Promise<AppendConversationResponse> {
    return await this.queue.enqueue(() => executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "append_conversation",
      payload: input,
      now: input.at,
      execute: () => {
        const session = this.requireOpenSession(input.sessionId);
        verifyExpectedHead(session, input.expectedHead);
        return {
          conversation: appendConversationMessage(this.database, input),
        };
      },
    }));
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.queue.enqueue(() => {
      const normalized = {
        ...input,
        at: input.at ?? this.now(),
      };
      return executeIdempotent({
        database: this.database,
        requestId: input.requestId,
        operation: "start_run",
        payload: normalized,
        now: normalized.at,
        execute: () => {
          const session = this.requireOpenSession(input.sessionId);
          verifyExpectedHead(session, input.expectedHead);
          return {
            run: startSessionRun(this.database, normalized),
          };
        },
      });
    });
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.queue.enqueue(() => executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "record_run_step",
      payload: input,
      now: input.at,
      execute: () => {
        const session = this.requireOpenSession(input.sessionId);
        verifyExpectedHead(session, input.expectedHead);
        return {
          toolCall: recordRunStep(this.database, input),
        };
      },
    }));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue.close();
    this.database.close();
  }

  private ensureSession(
    input: EnsureActiveSessionRequest,
    createdAt: string,
  ): EnsureActiveSessionResponse {
    validateSessionInput(input);
    const agentId = normalizeAgentId(input.agentId);
    const existing = readLiveSessionForAgent(this.database, agentId);
    if (existing) {
      if (existing.date !== input.date) {
        throw new GitContextServiceError({
          code: "SESSION_ROLLOVER_PENDING",
          message: "A previous daily session must be sealed before creating the requested session.",
          retryable: true,
          details: {
            activeSessionId: existing.sessionId,
            activeDate: existing.date,
            requestedDate: input.date,
          },
        });
      }
      if (existing.timezone !== input.timezone) {
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
      verifyExpectedHead(existing, input.expectedHead);
      return {
        session: existing,
        created: false,
      };
    }

    const sessionId = "S-" + input.date.replaceAll("-", "") + "-" + agentId;
    const previousSessionId = readLatestSealedSessionId(this.database, agentId);
    const session = insertSession(this.database, {
      sessionId,
      date: input.date,
      timezone: input.timezone,
      agentId,
      repositoryPath: join(this.dataRoot, "sessions", sessionId),
      ...(previousSessionId ? { previousSessionId } : {}),
      createdAt,
    });
    return {
      session,
      created: true,
    };
  }

  private requireOpenSession(sessionId: string): SessionRef {
    const session = readSession(this.database, sessionId);
    if (!session) {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session does not exist.",
        details: { sessionId },
      });
    }
    if (session.status !== "open") {
      throw new GitContextServiceError({
        code: session.status === "rollover_pending"
          ? "SESSION_ROLLOVER_PENDING"
          : "SESSION_NOT_ACTIVE",
        message: "Session is not open for new run activity.",
        retryable: session.status === "rollover_pending",
        details: { sessionId, status: session.status },
      });
    }
    return session;
  }
}

function validateSessionInput(input: EnsureActiveSessionRequest): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Session date must use YYYY-MM-DD format.",
    });
  }
  if (normalizeAgentId(input.agentId).length === 0) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Agent ID must contain a letter or number.",
    });
  }
}

function normalizeAgentId(agentId: string): string {
  return agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function verifyExpectedHead(session: SessionRef, expectedHead: string | undefined): void {
  if (expectedHead === undefined) {
    return;
  }
  if (session.head !== expectedHead) {
    throw new GitContextServiceError({
      code: "SESSION_HEAD_MISMATCH",
      message: "Session HEAD does not match the caller expectation.",
      retryable: true,
      details: {
        sessionId: session.sessionId,
        expectedHead,
        actualHead: session.head,
      },
    });
  }
}
