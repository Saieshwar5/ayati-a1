import { join } from "node:path";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type ActiveContext,
  type CheckpointMutationRequest,
  type CheckpointMutationResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeSessionRunRequest,
  type FinalizeSessionRunResponse,
  type FinalizeTaskRunRequest,
  type FinalizeTaskRunResponse,
  type GetActiveContextRequest,
  type GetTaskRequest,
  type GetTaskResponse,
  type HealthResponse,
  type MountTaskRequest,
  type MountTaskResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type SessionRef,
  type SnapshotTaskRunEvidenceRequest,
  type SnapshotTaskRunEvidenceResponse,
  type StartRunRequest,
  type StartRunResponse,
  type VerifyMutationRequest,
  type VerifyMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { synchronizePendingConversationFiles } from "../conversations/conversation-synchronizer.js";
import { GitContextServiceError } from "../errors.js";
import { ensureSessionRepository } from "../git/session-repository.js";
import {
  appendConversationMessage,
  readConversation,
} from "../repositories/conversation-records.js";
import {
  insertSession,
  readLatestSealedSessionId,
  readSessionRecord,
  updateSessionHead,
} from "../repositories/session-records.js";
import type { GitContextService } from "../service.js";
import { SerializedWriteQueue } from "../write-queue.js";
import { ActiveContextCache, activeContextRevision } from "./active-context-cache.js";
import { MutationBoundaryService } from "./mutation-boundary-service.js";
import { TaskCheckpointService } from "./task-checkpoint-service.js";
import { TaskLifecycleService } from "./task-lifecycle-service.js";
import { TaskRunEvidenceService } from "./task-run-evidence-service.js";
import { TaskRunFinalizationService } from "./task-run-finalization-service.js";
import { SessionRegistryCache } from "./session-registry-cache.js";
import { ConversationHotCache } from "./conversation-hot-cache.js";
import {
  normalizeAgentId,
  validateSessionInput,
  verifyExpectedHead,
} from "./session-policy.js";
import { SessionSummaryHotCache } from "./session-summary-hot-cache.js";
import { SessionRunLifecycleService } from "./session-run-lifecycle-service.js";

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
  private readonly contextCache = new ActiveContextCache();
  private readonly sessionRegistry: SessionRegistryCache;
  private readonly conversationCache: ConversationHotCache;
  private readonly sessionSummaryCache = new SessionSummaryHotCache();
  private readonly sessionRuns: SessionRunLifecycleService;
  private readonly taskLifecycle: TaskLifecycleService;
  private readonly mutationBoundary: MutationBoundaryService;
  private readonly taskCheckpoint: TaskCheckpointService;
  private readonly taskRunEvidence: TaskRunEvidenceService;
  private readonly taskRunFinalization: TaskRunFinalizationService;
  private closed = false;
  private startupRecovered = false;

  constructor(options: SqliteGitContextServiceOptions) {
    this.database = options.database;
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sessionRegistry = new SessionRegistryCache(this.database);
    this.conversationCache = new ConversationHotCache(this.database);
    this.sessionRuns = new SessionRunLifecycleService(this.database);
    this.taskLifecycle = new TaskLifecycleService({
      database: this.database,
      dataRoot: this.dataRoot,
      now: this.now,
    });
    this.mutationBoundary = new MutationBoundaryService(this.database);
    this.taskCheckpoint = new TaskCheckpointService(this.database);
    this.taskRunEvidence = new TaskRunEvidenceService(this.database);
    this.taskRunFinalization = new TaskRunFinalizationService(this.database);
  }

  async getHealth(): Promise<HealthResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
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
          "tasks",
          "mutations",
          "recovery",
        ],
      };
    });
  }

  async getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const sessionRecord = input.sessionId
        ? this.sessionRegistry.getSession(this.database, input.sessionId)
        : this.sessionRegistry.getLatestLiveSession();
      if (!sessionRecord) {
        return {
          session: null,
          warnings: [],
        };
      }
      const session = this.sessionRegistry.toRef(sessionRecord);
      const sessionSummary = this.sessionSummaryCache.get(session.sessionId, session.head)
        ?? await this.sessionSummaryCache.refresh(session);
      const run = this.sessionRuns.getActive(session.sessionId);
      const conversations = this.conversationCache.getPendingContexts(
        this.database,
        session.sessionId,
      );
      const { revision, pendingDigest } = activeContextRevision({
        head: session.head,
        status: session.status,
        conversations,
        ...(run ? { run } : {}),
      });
      const cached = this.contextCache.get(session.sessionId, revision);
      if (cached) {
        return cached;
      }
      const context: ActiveContext = {
        session: {
          session,
          summary: sessionSummary.summary,
          pendingConversation: this.conversationCache.getPendingConversations(
            this.database,
            session.sessionId,
          ),
          pendingConversationContext: conversations,
          pendingDigest,
          recentCommits: sessionSummary.recentCommits,
        },
        ...(run
          ? {
              run,
            }
          : {}),
        warnings: [],
      };
      this.contextCache.set(session.sessionId, revision, context);
      return context;
    });
  }

  async ensureActiveSession(
    input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const now = input.at ?? this.now();
      const pending = beginRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        operation: "ensure_active_session",
        payload: input,
        now,
        execute: () => this.ensureSession(input, now),
      });
      try {
        const session = await this.ensureRepositoryForSession(
          pending.result.session.sessionId,
        );
        const result: EnsureActiveSessionResponse = {
          session,
          created: pending.result.created,
        };
        this.contextCache.clear();
        return completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result,
          now,
        });
      } catch (error) {
        markRecoverableIdempotencyFailed({
          database: this.database,
          requestId: input.requestId,
        });
        throw error;
      }
    });
  }

  async appendConversation(
    input: AppendConversationRequest,
  ): Promise<AppendConversationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const pending = beginRecoverableIdempotent({
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
      });
      this.conversationCache.refreshSession(this.database, input.sessionId);
      this.contextCache.clear();
      try {
        const conversation = readConversation(
          this.database,
          pending.result.conversation.conversationId,
        );
        if (!conversation) {
          throw new Error("Persisted conversation could not be read.");
        }
        const result: AppendConversationResponse = { conversation };
        return completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result,
          now: input.at,
        });
      } catch (error) {
        markRecoverableIdempotencyFailed({
          database: this.database,
          requestId: input.requestId,
        });
        throw error;
      }
    });
  }

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      return await this.taskLifecycle.createTask(input);
    });
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.taskLifecycle.getTask(input);
    });
  }

  async mountTask(input: MountTaskRequest): Promise<MountTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      return await this.taskLifecycle.mountTask(input, session);
    });
  }

  async acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.mutationBoundary.acquire(input, session);
      this.sessionRuns.refresh(input.runId);
      this.contextCache.clear();
      return result;
    });
  }

  async verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = await this.mutationBoundary.verify(input);
      this.contextCache.clear();
      return result;
    });
  }

  async checkpointMutation(
    input: CheckpointMutationRequest,
  ): Promise<CheckpointMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = await this.taskCheckpoint.checkpoint(input);
      this.contextCache.clear();
      return result;
    });
  }

  async snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      return await this.taskRunEvidence.snapshot(input, session);
    });
  }

  async finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      let result: FinalizeTaskRunResponse;
      try {
        result = await this.taskRunFinalization.finalize(input, session);
      } finally {
        this.sessionRuns.remove(input.runId);
        this.conversationCache.refreshSession(this.database, input.sessionId);
        this.contextCache.clear();
      }
      const updatedSession = readSessionRecord(this.database, input.sessionId);
      if (updatedSession) {
        this.sessionRegistry.set(updatedSession);
        try {
          await this.sessionSummaryCache.refresh(this.sessionRegistry.toRef(updatedSession));
        } catch {
          this.sessionSummaryCache.invalidate(input.sessionId);
        }
      }
      return result;
    });
  }

  async finalizeSessionRun(
    input: FinalizeSessionRunRequest,
  ): Promise<FinalizeSessionRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      try {
        return await this.sessionRuns.finalize(input, session);
      } finally {
        this.conversationCache.refreshSession(this.database, input.sessionId);
        this.contextCache.clear();
      }
    });
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = this.sessionRuns.start(input, input.at ?? this.now());
      this.contextCache.clear();
      return result;
    });
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireOpenSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = this.sessionRuns.recordStep(input);
      this.contextCache.clear();
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue.close();
    this.sessionRuns.clear();
    this.database.close();
  }

  private async ensureStartupRecovery(): Promise<void> {
    if (this.startupRecovered) return;
    const session = this.sessionRegistry.getLatestLiveSession();
    if (session) {
      await this.ensureRepositoryForSession(session.sessionId);
    }
    await synchronizePendingConversationFiles({
      database: this.database,
      now: this.now,
    });
    if (session) {
      this.conversationCache.refreshSession(this.database, session.sessionId);
    }
    await this.taskLifecycle.recoverInitializingState();
    this.startupRecovered = true;
  }

  private async ensureRepositoryForSession(sessionId: string): Promise<SessionRef> {
    const record = this.sessionRegistry.getSession(this.database, sessionId);
    if (!record) {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session does not exist.",
        details: { sessionId },
      });
    }
    const session = this.sessionRegistry.toRef(record);
    let head: string;
    try {
      head = await ensureSessionRepository({
        session,
        agentId: record.agentId,
        createdAt: record.createdAt,
      });
    } catch (error) {
      if (error instanceof GitContextServiceError) {
        throw error;
      }
      throw new GitContextServiceError({
        code: "REPOSITORY_UNAVAILABLE",
        message: "Session repository could not be initialized or recovered.",
        retryable: true,
        details: {
          sessionId,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
    if (session.head === head) {
      await this.sessionSummaryCache.refresh(session);
      return session;
    }
    this.contextCache.clear();
    const updated = updateSessionHead(this.database, sessionId, head);
    this.sessionRegistry.updateHead(sessionId, head);
    await this.sessionSummaryCache.refresh(updated);
    return updated;
  }

  private ensureSession(
    input: EnsureActiveSessionRequest,
    createdAt: string,
  ): EnsureActiveSessionResponse {
    validateSessionInput(input);
    const agentId = normalizeAgentId(input.agentId);
    let existingRecord = this.sessionRegistry.getLiveSessionForAgent(agentId);
    if (existingRecord && existingRecord.date !== input.date) {
      const refreshed = readSessionRecord(this.database, existingRecord.sessionId);
      if (refreshed) this.sessionRegistry.set(refreshed);
      existingRecord = this.sessionRegistry.getLiveSessionForAgent(agentId);
    }
    const existing = existingRecord
      ? this.sessionRegistry.toRef(existingRecord)
      : undefined;
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
    const record = readSessionRecord(this.database, session.sessionId);
    if (!record) throw new Error("Inserted session record could not be read.");
    this.sessionRegistry.set(record);
    return {
      session,
      created: true,
    };
  }

  private requireOpenSession(sessionId: string): SessionRef {
    const record = this.sessionRegistry.getSession(this.database, sessionId);
    if (!record) {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session does not exist.",
        details: { sessionId },
      });
    }
    const session = this.sessionRegistry.toRef(record);
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
