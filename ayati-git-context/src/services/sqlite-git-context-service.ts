import { join } from "node:path";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AdoptTaskReferenceRequest,
  type AdoptTaskReferenceResponse,
  type ActivateTaskRunRequest,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type BindTaskAttachmentsRequest,
  type BindTaskAttachmentsResponse,
  type ActiveContext,
  type CompleteContextTurnRequest,
  type CompleteContextTurnResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRunRequest,
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
  type ListTasksRequest,
  type ListTasksResponse,
  type PlanTaskRequestRouteRequest,
  type PlanTaskRequestRouteResponse,
  type PrepareContextTurnRequest,
  type PrepareContextTurnResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordSessionAttachmentsRequest,
  type RecordSessionAttachmentsResponse,
  type SessionRef,
  type StartRunRequest,
  type StartRunResponse,
  type SelectedTaskRunResponse,
  type VerifyMutationRequest,
  type VerifyMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { synchronizePendingConversationFiles } from "../conversations/conversation-synchronizer.js";
import { GitContextServiceError } from "../errors.js";
import {
  appendConversationMessage,
  readConversation,
  readConversationMessage,
} from "../repositories/conversation-records.js";
import { readConversationPersistenceState } from "../repositories/conversation-persistence-records.js";
import {
  insertSession,
  readLatestSealedSessionId,
  readSessionRecord,
} from "../repositories/session-records.js";
import type { GitContextService } from "../service.js";
import { SerializedWriteQueue } from "../write-queue.js";
import { ActiveContextCache, activeContextRevision } from "./active-context-cache.js";
import { ActiveContextProjectionService } from "./active-context-projection-service.js";
import {
  ActiveContextDataCache,
  DEFAULT_TASK_CANDIDATE_CACHE_INTERVAL_MS,
} from "./active-context-data-cache.js";
import {
  ActiveContextInvalidation,
  type ContextInvalidationInput,
} from "./active-context-invalidation.js";
import { MutationBoundaryService } from "./mutation-boundary-service.js";
import { TaskLifecycleService } from "./task-lifecycle-service.js";
import { TaskRunFinalizationService } from "./task-run-finalization-service.js";
import { TaskAttachmentService } from "./task-attachment-service.js";
import { SessionRegistryCache } from "./session-registry-cache.js";
import { ConversationHotCache } from "./conversation-hot-cache.js";
import { ContextTurnCompletionService } from "./context-turn-completion-service.js";
import {
  normalizeAgentId,
  validateSessionInput,
  verifyExpectedHead,
} from "./session-policy.js";
import { SessionSummaryHotCache } from "./session-summary-hot-cache.js";
import {
  DEFAULT_SESSION_REPOSITORY_VALIDATION_INTERVAL_MS,
  SessionRepositoryValidationService,
} from "./session-repository-validation-service.js";
import { SessionRunLifecycleService } from "./session-run-lifecycle-service.js";
import {
  completePreparedContextTurnReceipt,
  createPreparedContextTurnReceipt,
  requirePreparedContextTurnReceipt,
  type PreparedContextTurnReceipt,
} from "./prepared-context-turn-receipt.js";
import { TaskRunSelectionService } from "./task-run-selection-service.js";
import { TaskRequestRoutingService } from "./task-request-routing-service.js";
import { readMutationAuthority } from "../repositories/mutation-authority-records.js";
import { readRun } from "../repositories/run-records.js";
import { GitContextObserver } from "../observability.js";
import { GitContextServiceObservability } from "./service-observability.js";
import { buildReadContext } from "./read-context-builder.js";
import {
  DailySessionRolloverService,
  localDate,
} from "./daily-session-rollover-service.js";

export interface SqliteGitContextServiceOptions {
  database: ContextDatabase;
  dataRoot: string;
  workspaceRoot?: string;
  now?: () => string;
  observer?: GitContextObserver;
  rolloverCheckIntervalMs?: number;
  sessionRepositoryValidationIntervalMs?: number;
  taskCandidateCacheIntervalMs?: number;
}

export class SqliteGitContextService implements GitContextService {
  private readonly database: ContextDatabase;
  private readonly dataRoot: string;
  private readonly now: () => string;
  private readonly observer: GitContextObserver;
  private readonly events: GitContextServiceObservability;
  private readonly queue = new SerializedWriteQueue();
  private readonly contextCache = new ActiveContextCache();
  private readonly activeContextProjection: ActiveContextProjectionService;
  private readonly contextDataCache: ActiveContextDataCache;
  private readonly contextInvalidation: ActiveContextInvalidation;
  private readonly sessionRegistry: SessionRegistryCache;
  private readonly conversationCache: ConversationHotCache;
  private readonly contextTurnCompletion: ContextTurnCompletionService;
  private readonly sessionSummaryCache = new SessionSummaryHotCache();
  private readonly sessionRepositoryValidation: SessionRepositoryValidationService;
  private readonly sessionRuns: SessionRunLifecycleService;
  private readonly taskLifecycle: TaskLifecycleService;
  private readonly taskSelection: TaskRunSelectionService;
  private readonly taskRequestRouting: TaskRequestRoutingService;
  private readonly mutationBoundary: MutationBoundaryService;
  private readonly taskRunFinalization: TaskRunFinalizationService;
  private readonly taskAttachments: TaskAttachmentService;
  private readonly dailySessionRollover: DailySessionRolloverService;
  private readonly rolloverCheckIntervalMs: number;
  private rolloverTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private startupRecovered = false;

  constructor(options: SqliteGitContextServiceOptions) {
    this.database = options.database;
    this.dataRoot = options.dataRoot;
    this.now = options.now ?? (() => new Date().toISOString());
    this.observer = options.observer ?? new GitContextObserver("git-context-engine");
    this.events = new GitContextServiceObservability(this.observer);
    this.rolloverCheckIntervalMs = options.rolloverCheckIntervalMs ?? 60_000;
    this.sessionRegistry = new SessionRegistryCache(this.database);
    this.conversationCache = new ConversationHotCache(this.database);
    this.sessionRepositoryValidation = new SessionRepositoryValidationService({
      database: this.database,
      sessionRegistry: this.sessionRegistry,
      sessionSummaryCache: this.sessionSummaryCache,
      events: this.events,
      invalidateContext: (reason, sessionId) => {
        this.invalidateContext(reason, { sessionId });
      },
      maxAgeMs: options.sessionRepositoryValidationIntervalMs
        ?? DEFAULT_SESSION_REPOSITORY_VALIDATION_INTERVAL_MS,
      now: this.now,
    });
    this.sessionRuns = new SessionRunLifecycleService(this.database);
    const workspaceRoot = options.workspaceRoot ?? join(this.dataRoot, "workspace");
    const taskRoot = join(workspaceRoot, "tasks");
    this.taskLifecycle = new TaskLifecycleService({
      database: this.database,
      dataRoot: this.dataRoot,
      workspaceRoot,
      now: this.now,
    });
    this.taskRequestRouting = new TaskRequestRoutingService({
      database: this.database,
      taskRoot,
    });
    this.taskSelection = new TaskRunSelectionService(
      this.database,
      this.taskLifecycle,
      this.sessionRuns,
      this.taskRequestRouting,
      this.observer,
    );
    this.mutationBoundary = new MutationBoundaryService(
      this.database,
      taskRoot,
    );
    this.taskRunFinalization = new TaskRunFinalizationService(
      this.database,
      taskRoot,
      async (phase, record) => {
        if (phase !== "plan_persisted") return;
        this.events.emit({
          level: "info",
          event: "task_mutation_staged",
          requestId: record.requestId,
          sessionId: record.sessionId,
          runId: record.runId,
          taskId: record.taskId,
          outcome: "succeeded",
          data: {
            authorityId: record.authorityId,
            baseHead: record.baseHead,
            stagedPaths: record.plan.stagedPaths,
          },
        });
      },
    );
    this.taskAttachments = new TaskAttachmentService({
      database: this.database,
      taskRoot,
    });
    this.contextDataCache = new ActiveContextDataCache({
      database: this.database,
      loadReadContext: (sessionId) => buildReadContext(this.database, sessionId),
      loadAttachments: (sessionId) => this.taskAttachments.sessionProjection(sessionId),
      loadTaskCandidates: async (limit) => await this.taskLifecycle.listRoutingCandidates({ limit }),
      taskCandidateMaxAgeMs: options.taskCandidateCacheIntervalMs
        ?? DEFAULT_TASK_CANDIDATE_CACHE_INTERVAL_MS,
      now: this.now,
    });
    this.contextInvalidation = new ActiveContextInvalidation({
      contextCache: this.contextCache,
      dataCache: this.contextDataCache,
      events: this.events,
    });
    this.activeContextProjection = new ActiveContextProjectionService({
      database: this.database,
      sessionRegistry: this.sessionRegistry,
      conversationCache: this.conversationCache,
      contextDataCache: this.contextDataCache,
      contextCache: this.contextCache,
      events: this.events,
      loadSessionSummary: async (session) => this.sessionSummaryCache.get(
        session.sessionId,
        session.head,
      ) ?? await this.sessionSummaryCache.refresh(session),
      loadActiveRun: (sessionId) => this.sessionRuns.getActive(sessionId),
      loadActiveTask: async (_sessionId, run) => run.run.taskId
        ? await this.taskRequestRouting.projectContext(
            run.run.runId,
            await this.taskLifecycle.readContext(
              (await this.taskLifecycle.getTask({ taskId: run.run.taskId })).task,
            ),
          )
        : undefined,
    });
    this.contextTurnCompletion = new ContextTurnCompletionService({
      database: this.database,
      contextCache: this.contextCache,
      contextDataCache: this.contextDataCache,
      conversationCache: this.conversationCache,
      events: this.events,
      requireSession: (sessionId) => this.requireSession(sessionId),
      requireWritableSession: (sessionId) => this.requireWritableSession(sessionId),
      loadActiveRun: (sessionId) => this.sessionRuns.getActive(sessionId),
      invalidateContext: (reason, sessionId) => {
        this.invalidateContext(reason, { sessionId });
      },
    });
    this.dailySessionRollover = new DailySessionRolloverService({
      database: this.database,
      dataRoot: this.dataRoot,
      sessionRegistry: this.sessionRegistry,
      conversationCache: this.conversationCache,
      events: this.events,
      invalidateContext: (reason, sessionId) => {
        this.invalidateContext(reason, { sessionId });
      },
    });
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
          "attachments",
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
        return this.activeContextProjection.unavailable();
      }
      return await this.activeContextProjection.build(sessionRecord);
    });
  }

  async prepareContextTurn(
    input: PrepareContextTurnRequest,
  ): Promise<PrepareContextTurnResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const existingRequest = hasRecoverableIdempotencyRequest({
        database: this.database,
        requestId: input.requestId,
        operation: "prepare_context_turn",
        payload: input,
      });
      const rollover = existingRequest
        ? undefined
        : await this.reconcileRequestedDailySession(input, input.at);
      const pending = beginRecoverableIdempotent<PreparedContextTurnReceipt>({
        database: this.database,
        requestId: input.requestId,
        operation: "prepare_context_turn",
        payload: input,
        now: input.at,
        execute: () => {
          const ensured = this.ensureSession(input, input.at, rollover?.created === true);
          const appended = appendConversationMessage(this.database, {
            requestId: input.requestId,
            sessionId: ensured.session.sessionId,
            role: input.role,
            content: input.content,
            at: input.at,
          });
          return createPreparedContextTurnReceipt({
            sessionId: ensured.session.sessionId,
            sessionCreated: ensured.created || rollover?.created === true,
            conversationId: appended.conversation.conversationId,
            messageId: appended.message.messageId,
          });
        },
      });
      try {
        const receipt = requirePreparedContextTurnReceipt(pending.result);
        const session = await this.sessionRepositoryValidation.ensure(
          receipt.sessionId,
          "request",
        );
        const conversation = readConversation(this.database, receipt.conversationId);
        const message = readConversationMessage(this.database, receipt.messageId);
        const persistence = readConversationPersistenceState(
          this.database,
          receipt.conversationId,
        );
        if (!conversation
          || conversation.sessionId !== receipt.sessionId
          || !message
          || message.conversationId !== receipt.conversationId
          || !persistence) {
          throw new Error("Prepared context turn receipt does not resolve to durable records.");
        }
        if (!pending.completed) {
          if (existingRequest) {
            this.conversationCache.refreshSession(this.database, session.sessionId);
          } else {
            this.conversationCache.append(session.sessionId, conversation, message);
          }
          this.invalidateContext("conversation_persisted", { sessionId: session.sessionId });
        }

        const sessionRecord = this.sessionRegistry.getSession(this.database, session.sessionId);
        if (!sessionRecord) {
          throw new Error("Prepared context turn could not be reconstructed.");
        }
        const context = await this.activeContextProjection.build(sessionRecord);
        const result: PrepareContextTurnResponse = {
          session,
          sessionCreated: receipt.sessionCreated,
          conversation,
          message,
          persistence,
          context,
        };
        if (pending.completed) {
          this.events.emit({
            level: "debug",
            event: "context_turn_replayed",
            requestId: input.requestId,
            sessionId: session.sessionId,
            conversationId: conversation.conversationId,
            outcome: "succeeded",
            data: {
              storedContextRevision: receipt.contextRevision,
              contextRevision: context.contextRevision,
              conversationPersistence: result.persistence,
            },
          });
          return result;
        }
        completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result: completePreparedContextTurnReceipt(receipt, context.contextRevision),
          now: input.at,
        });
        this.events.emit({
          level: "info",
          event: "session_ensured",
          requestId: input.requestId,
          sessionId: session.sessionId,
          outcome: "succeeded",
          data: {
            created: result.sessionCreated,
            status: result.session.status,
            head: result.session.head,
            sourceOperation: "prepare_context_turn",
          },
        });
        this.events.emit({
          level: "info",
          event: "conversation_persisted",
          requestId: input.requestId,
          sessionId: session.sessionId,
          conversationId: result.conversation.conversationId,
          outcome: "succeeded",
          data: {
            role: input.role,
            conversationSequence: result.conversation.sequence,
            status: result.conversation.status,
            contentBytes: Buffer.byteLength(input.content),
            sourceOperation: "prepare_context_turn",
            conversationPersistence: result.persistence,
          },
        });
        this.events.emit({
          level: "info",
          event: "context_turn_prepared",
          requestId: input.requestId,
          sessionId: session.sessionId,
          conversationId: result.conversation.conversationId,
          outcome: "succeeded",
          data: {
            role: input.role,
            sessionCreated: result.sessionCreated,
            contextRevision: result.context.contextRevision,
          },
        });
        return result;
      } catch (error) {
        markRecoverableIdempotencyFailed({
          database: this.database,
          requestId: input.requestId,
        });
        throw error;
      }
    });
  }

  async completeContextTurn(
    input: CompleteContextTurnRequest,
  ): Promise<CompleteContextTurnResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.contextTurnCompletion.complete(input);
    });
  }

  async ensureActiveSession(
    input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const now = input.at ?? this.now();
      const existingRequest = hasRecoverableIdempotencyRequest({
        database: this.database,
        requestId: input.requestId,
        operation: "ensure_active_session",
        payload: input,
      });
      const rollover = existingRequest
        ? undefined
        : await this.reconcileRequestedDailySession(input, now);
      const pending = beginRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        operation: "ensure_active_session",
        payload: input,
        now,
        execute: () => this.ensureSession(input, now, rollover?.created === true),
      });
      try {
        const session = await this.sessionRepositoryValidation.ensure(
          pending.result.session.sessionId,
          "request",
        );
        const result: EnsureActiveSessionResponse = {
          session,
          created: pending.result.created || rollover?.created === true,
        };
        const completed = completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result,
          now,
        });
        this.events.emit({
          level: "info",
          event: "session_ensured",
          requestId: input.requestId,
          sessionId: session.sessionId,
          outcome: "succeeded",
          data: { created: completed.created, status: completed.session.status, head: completed.session.head },
        });
        return completed;
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
          const session = this.requireWritableSession(input.sessionId);
          verifyExpectedHead(session, input.expectedHead);
          return appendConversationMessage(this.database, input);
        },
      });
      const conversations = this.conversationCache.append(
        input.sessionId,
        pending.result.conversation,
        pending.result.message,
      );
      const currentConversations = conversations.length > 0
        ? conversations
        : this.conversationCache.refreshSession(this.database, input.sessionId);
      this.invalidateContext("conversation_persisted", { sessionId: input.sessionId });
      try {
        const conversation = readConversation(
          this.database,
          pending.result.conversation.conversationId,
        );
        if (!conversation) {
          throw new Error("Persisted conversation could not be read.");
        }
        const session = this.requireWritableSession(input.sessionId);
        const run = this.sessionRuns.getActive(input.sessionId);
        const taskCandidates = await this.contextDataCache.taskCandidates(20);
        const readContext = this.contextDataCache.readContext(input.sessionId);
        const attachments = this.contextDataCache.attachments(input.sessionId);
        const revision = activeContextRevision({
          head: session.head,
          status: session.status,
          conversations: currentConversations,
          readContext,
          ...(attachments ? { attachments } : {}),
          ...(run ? { run } : {}),
          taskCandidates,
        });
        const result: AppendConversationResponse = {
          conversation,
          message: pending.result.message,
          contextRevision: revision.revision,
          pendingDigest: revision.pendingDigest,
        };
        const completed = completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result,
          now: input.at,
        });
        this.events.emit({
          level: "info",
          event: "conversation_persisted",
          requestId: input.requestId,
          sessionId: input.sessionId,
          conversationId: completed.conversation.conversationId,
          outcome: "succeeded",
          data: {
            role: input.role,
            conversationSequence: completed.conversation.sequence,
            status: completed.conversation.status,
            contentBytes: Buffer.byteLength(input.content),
          },
        });
        return completed;
      } catch (error) {
        markRecoverableIdempotencyFailed({
          database: this.database,
          requestId: input.requestId,
        });
        throw error;
      }
    });
  }

  async createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskSelection.create(input);
      this.sessionRuns.refresh(result.run.runId);
      this.invalidateContext("task_run_created", {
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
        allSessions: true,
        taskCandidates: true,
      });
      this.events.taskSelected("created", result);
      return result;
    });
  }

  async activateTaskRun(input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskSelection.activate(input);
      this.sessionRuns.refresh(result.run.runId);
      this.invalidateContext("task_run_activated", {
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
        allSessions: true,
        taskCandidates: true,
      });
      this.events.taskSelected("activated", result);
      return result;
    });
  }

  async planTaskRequestRoute(
    input: PlanTaskRequestRouteRequest,
  ): Promise<PlanTaskRequestRouteResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireWritableSession(input.sessionId);
      const result = await this.taskRequestRouting.plan(input);
      this.sessionRuns.refresh(input.runId);
      this.invalidateContext("task_request_route_planned", {
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
      });
      return result;
    });
  }

  async listTasks(input: ListTasksRequest): Promise<ListTasksResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.taskLifecycle.listTasks(input);
    });
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.taskLifecycle.getTask(input);
    });
  }

  async recordSessionAttachments(
    input: RecordSessionAttachmentsRequest,
  ): Promise<RecordSessionAttachmentsResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireWritableSession(input.sessionId);
      const result = await this.taskAttachments.record(input);
      this.invalidateContext("session_attachments_recorded", {
        sessionId: input.sessionId,
        attachments: true,
      });
      return result;
    });
  }

  async bindTaskAttachments(
    input: BindTaskAttachmentsRequest,
  ): Promise<BindTaskAttachmentsResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireWritableSession(input.sessionId);
      const result = await this.taskAttachments.bind(input);
      this.invalidateContext("task_attachments_bound", {
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
      });
      return result;
    });
  }

  async adoptTaskReference(
    input: AdoptTaskReferenceRequest,
  ): Promise<AdoptTaskReferenceResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = await this.taskAttachments.adopt(input);
      const run = readRun(this.database, result.runId);
      this.invalidateContext("task_reference_adopted", {
        sessionId: run?.sessionId,
        runId: result.runId,
        taskId: result.taskId,
        allSessions: true,
        taskCandidates: true,
      });
      return result;
    });
  }

  async acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.mutationBoundary.acquire(input);
      this.sessionRuns.refresh(input.runId);
      this.invalidateContext("mutation_authority_acquired", {
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
      });
      this.events.emit({
        level: "info",
        event: "mutation_authority_acquired",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "succeeded",
        data: { authorityId: result.authority.authorityId, targetCount: input.targets.length },
      });
      return result;
    });
  }

  async verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const authority = readMutationAuthority(this.database, input.authorityId);
      const result = await this.mutationBoundary.verify(input);
      this.invalidateContext("mutation_verified", {
        sessionId: authority?.sessionId,
        runId: authority?.runId,
        taskId: authority?.taskId,
        allSessions: true,
        taskCandidates: true,
      });
      this.events.emit({
        level: result.verified ? "info" : "warn",
        event: "mutation_verified",
        requestId: input.requestId,
        outcome: result.verified ? "succeeded" : "failed",
        data: {
          authorityId: result.authorityId,
          verified: result.verified,
          mutationOutcome: result.outcome,
          changedPathCount: result.provenance.created.length
            + result.provenance.modified.length
            + result.provenance.deleted.length
            + result.provenance.renamed.length,
        },
      });
      return result;
    });
  }

  async finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireSession(input.sessionId);
      const selectedRun = readRun(this.database, input.runId);
      const selectedTask = await this.taskLifecycle.getTask({ taskId: input.taskId });
      let result: FinalizeTaskRunResponse;
      this.events.emit({
        level: "info",
        event: "task_finalization_started",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "started",
        data: {
          workingDirectory: selectedTask.task.workingPath,
          taskRequestId: selectedRun?.taskRequestId,
          requestedOutcome: input.outcome,
          validation: input.validation,
        },
      });
      try {
        result = await this.taskRunFinalization.finalize(input, session);
      } catch (error) {
        this.events.emit({
          level: "error",
          event: "task_finalization_failed",
          requestId: input.requestId,
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this.sessionRuns.remove(input.runId);
        this.conversationCache.refreshSession(this.database, input.sessionId);
        this.invalidateContext("task_finalization", {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          allSessions: true,
          readContext: true,
          taskCandidates: true,
        });
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
      this.events.emit({
        level: "info",
        event: "task_finalization_completed",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "succeeded",
        data: {
          outcome: result.outcome,
          workingDirectory: selectedTask.task.workingPath,
          taskRequestId: selectedRun?.taskRequestId,
          taskHeadBefore: result.taskHeadBefore,
          taskHeadAfter: result.taskHeadAfter,
          taskCommit: result.taskFinalizationCommit,
          taskCommitCreated: result.taskCommitCreated,
          sessionCommit: result.sessionCommit,
          readContextReset: true,
        },
      });
      await this.reconcileLatestDailySession(input.at);
      return result;
    });
  }

  async finalizeSessionRun(
    input: FinalizeSessionRunRequest,
  ): Promise<FinalizeSessionRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      try {
        const result = await this.sessionRuns.finalize(input, session);
        this.events.emit({
          level: "info",
          event: "session_run_finalized",
          requestId: input.requestId,
          sessionId: input.sessionId,
          runId: input.runId,
          outcome: "succeeded",
          data: { stepCount: result.stepCount, status: result.status },
        });
        return result;
      } finally {
        this.conversationCache.refreshSession(this.database, input.sessionId);
        this.invalidateContext("session_run_finalized", { sessionId: input.sessionId, runId: input.runId });
      }
    });
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = this.sessionRuns.start(input, input.at ?? this.now());
      this.invalidateContext("session_run_started", { sessionId: input.sessionId, runId: result.run.runId });
      this.events.emit({
        level: "info",
        event: "session_run_started",
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        runId: result.run.runId,
        outcome: "succeeded",
        data: { runClass: result.run.runClass, trigger: input.trigger },
      });
      return result;
    });
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = this.sessionRuns.recordStep(input);
      this.invalidateContext("run_step_persisted", {
        sessionId: input.sessionId,
        runId: input.runId,
        readContext: true,
      });
      this.events.runStepPersisted(input, result);
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.rolloverTimer) {
      clearInterval(this.rolloverTimer);
      this.rolloverTimer = undefined;
    }
    await this.queue.close();
    this.sessionRuns.clear();
    this.contextDataCache.clear();
    this.sessionRepositoryValidation.clear();
    this.database.close();
  }

  private async ensureStartupRecovery(): Promise<void> {
    if (this.startupRecovered) return;
    const startedAt = Date.now();
    this.events.emit({ level: "info", event: "startup_recovery_started", outcome: "started" });
    try {
      const session = this.sessionRegistry.getLatestLiveSession();
      if (session) {
        await this.sessionRepositoryValidation.ensure(session.sessionId, "startup");
      }
      await synchronizePendingConversationFiles({
        database: this.database,
        now: this.now,
      });
      if (session) {
        this.conversationCache.refreshSession(this.database, session.sessionId);
      }
      await this.taskLifecycle.recoverInitializingState();
      await this.taskRunFinalization.recoverSimpleTaskFinalizations(this.now());
      await this.reconcileLatestDailySession(this.now());
      this.startupRecovered = true;
      this.startRolloverTimer();
      this.events.emit({
        level: "info",
        event: "startup_recovery_completed",
        sessionId: session?.sessionId,
        durationMs: Date.now() - startedAt,
        outcome: "succeeded",
        data: { liveSessionFound: Boolean(session) },
      });
    } catch (error) {
      this.events.emit({
        level: "error",
        event: "startup_recovery_failed",
        durationMs: Date.now() - startedAt,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private invalidateContext(
    reason: string,
    input: ContextInvalidationInput,
  ): void {
    this.contextInvalidation.invalidate(reason, input);
  }

  private ensureSession(
    input: EnsureActiveSessionRequest,
    createdAt: string,
    rolloverCreated = false,
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
        return { session: existing, created: false };
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
      verifyExpectedHead(existing, rolloverCreated ? undefined : input.expectedHead);
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

  private requireWritableSession(sessionId: string): SessionRef {
    const session = this.requireSession(sessionId);
    if (session.status !== "open" && session.status !== "rollover_pending") {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session is not open for new run activity.",
        details: { sessionId, status: session.status },
      });
    }
    return session;
  }

  private requireSession(sessionId: string): SessionRef {
    const record = this.sessionRegistry.getSession(this.database, sessionId);
    if (!record) {
      throw new GitContextServiceError({
        code: "SESSION_NOT_ACTIVE",
        message: "Session does not exist.",
        details: { sessionId },
      });
    }
    return this.sessionRegistry.toRef(record);
  }

  private async reconcileLatestDailySession(at: string): Promise<SessionRef | undefined> {
    const existing = this.sessionRegistry.getLatestLiveSession();
    if (!existing) return undefined;
    const date = localDate(at, existing.timezone);
    const result = await this.dailySessionRollover.reconcile(existing, {
      date,
      timezone: existing.timezone,
      at,
    });
    if (result.created) {
      return await this.sessionRepositoryValidation.ensure(result.session.sessionId, "rollover");
    }
    return result.session;
  }

  private async reconcileRequestedDailySession(
    input: EnsureActiveSessionRequest,
    at: string,
  ): Promise<EnsureActiveSessionResponse | undefined> {
    validateSessionInput(input);
    const agentId = normalizeAgentId(input.agentId);
    let existing = this.sessionRegistry.getLiveSessionForAgent(agentId);
    if (existing && existing.date !== input.date) {
      const refreshed = readSessionRecord(this.database, existing.sessionId);
      if (refreshed) this.sessionRegistry.set(refreshed);
      existing = this.sessionRegistry.getLiveSessionForAgent(agentId);
    }
    if (!existing || existing.date === input.date) return undefined;
    verifyExpectedHead(this.sessionRegistry.toRef(existing), input.expectedHead);
    const result = await this.dailySessionRollover.reconcile(existing, {
      date: input.date,
      timezone: input.timezone,
      at,
    });
    if (result.created) {
      await this.sessionRepositoryValidation.ensure(result.session.sessionId, "rollover");
    }
    return result;
  }

  private startRolloverTimer(): void {
    if (this.rolloverTimer || this.closed || this.rolloverCheckIntervalMs <= 0) return;
    this.rolloverTimer = setInterval(() => {
      if (this.closed) return;
      void this.queue.enqueue(async () => {
        const session = await this.reconcileLatestDailySession(this.now());
        if (session) {
          await this.sessionRepositoryValidation.ensure(session.sessionId, "periodic");
        }
      }).catch((error: unknown) => {
        this.events.emit({
          level: "error",
          event: "session_rollover_check_failed",
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.rolloverCheckIntervalMs);
    this.rolloverTimer.unref?.();
  }
}
