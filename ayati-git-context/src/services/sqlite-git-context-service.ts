import { join } from "node:path";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AdoptTaskReferenceRequest,
  type AdoptTaskReferenceResponse,
  type ActivateTaskForRunRequest,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type BindTaskAttachmentsRequest,
  type BindTaskAttachmentsResponse,
  type ActiveContext,
  type CreateTaskForRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type FindTasksRequest,
  type FindTasksResponse,
  type GetActiveContextRequest,
  type GetTaskRequest,
  type GetTaskResponse,
  type HealthResponse,
  type InspectTaskLocationRequest,
  type InspectTaskLocationResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type PlanTaskRequestRouteRequest,
  type PlanTaskRequestRouteResponse,
  type PrepareContextTurnRequest,
  type PrepareContextTurnResponse,
  type ReadTaskRequest,
  type ReadTaskResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordSessionAttachmentsRequest,
  type RecordSessionAttachmentsResponse,
  type SessionRef,
  type SetTaskStarRequest,
  type SetTaskStarResponse,
  type SelectedTaskForRunResponse,
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
import { GitContextServiceError } from "../errors.js";
import {
  readConversation,
  readConversationMessage,
} from "../repositories/conversation-records.js";
import { readConversationPersistenceState } from "../repositories/conversation-persistence-records.js";
import {
  insertSession,
  readLatestSealedSessionId,
  readLiveSessionRecords,
  readSessionRecord,
  sessionRecordRef,
  updateSessionStatus,
} from "../repositories/session-records.js";
import type { GitContextService } from "../service.js";
import { SerializedWriteQueue } from "../write-queue.js";
import { ActiveContextCache } from "./active-context-cache.js";
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
import { TaskBoundFinalizationService } from "./task-bound-finalization-service.js";
import { TaskAttachmentService } from "./task-attachment-service.js";
import { SessionRegistryCache } from "./session-registry-cache.js";
import { ConversationHotCache } from "./conversation-hot-cache.js";
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
import { RunLifecycleService } from "./run-lifecycle-service.js";
import {
  completePreparedContextTurnReceipt,
  requirePreparedContextTurnReceipt,
} from "./prepared-context-turn-receipt.js";
import { TaskBindingService } from "./task-binding-service.js";
import { TaskRequestRoutingService } from "./task-request-routing-service.js";
import { readMutationAuthority } from "../repositories/mutation-authority-records.js";
import { readRun, readRunEvidence } from "../repositories/run-records.js";
import { GitContextObserver } from "../observability.js";
import { GitContextServiceObservability } from "./service-observability.js";
import { buildReadContext } from "./read-context-builder.js";
import {
  DailySessionRolloverService,
  localDate,
  type DailySessionRolloverAction,
} from "./daily-session-rollover-service.js";
import { TurnPreparationService } from "./turn-preparation-service.js";
import { UnboundRunFinalizationService } from "./unbound-run-finalization-service.js";
import { RunFinalizationService } from "./run-finalization-service.js";
import { StartupRunRecoveryService } from "./startup-run-recovery-service.js";
import { TaskDiscoveryService } from "./task-discovery-service.js";
import { refreshTaskDiscoveryProjection } from "../repositories/task-discovery-records.js";
import { TaskLocationService } from "./task-location-service.js";

export interface SqliteGitContextServiceOptions {
  database: ContextDatabase;
  dataRoot: string;
  workspaceRoot?: string;
  now?: () => string;
  observer?: GitContextObserver;
  rolloverCheckIntervalMs?: number;
  sessionRepositoryValidationIntervalMs?: number;
  taskCandidateCacheIntervalMs?: number;
  trustedRoots?: string[];
}

interface TurnRolloverAssessment {
  sessionId: string;
  action: DailySessionRolloverAction;
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
  private readonly turnPreparation: TurnPreparationService;
  private readonly sessionSummaryCache = new SessionSummaryHotCache();
  private readonly sessionRepositoryValidation: SessionRepositoryValidationService;
  private readonly runs: RunLifecycleService;
  private readonly taskLifecycle: TaskLifecycleService;
  private readonly taskLocations: TaskLocationService;
  private readonly taskDiscovery: TaskDiscoveryService;
  private readonly taskBinding: TaskBindingService;
  private readonly taskRequestRouting: TaskRequestRoutingService;
  private readonly mutationBoundary: MutationBoundaryService;
  private readonly runFinalization: RunFinalizationService;
  private readonly startupRunRecovery: StartupRunRecoveryService;
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
    this.runs = new RunLifecycleService(this.database);
    this.turnPreparation = new TurnPreparationService(this.database);
    const workspaceRoot = options.workspaceRoot ?? join(this.dataRoot, "workspace");
    const taskRoot = join(workspaceRoot, "tasks");
    this.taskLocations = new TaskLocationService({
      database: this.database,
      workspaceRoot,
      trustedRoots: options.trustedRoots ?? [],
      now: this.now,
    });
    this.taskDiscovery = new TaskDiscoveryService(this.database, this.now);
    this.taskLifecycle = new TaskLifecycleService({
      database: this.database,
      dataRoot: this.dataRoot,
      workspaceRoot,
      now: this.now,
      taskLocations: this.taskLocations,
      onContextRead: (task, context) => {
        refreshTaskDiscoveryProjection({
          database: this.database,
          task,
          context,
        });
      },
    });
    this.taskRequestRouting = new TaskRequestRoutingService({
      database: this.database,
      taskRoot,
    });
    this.taskBinding = new TaskBindingService(
      this.database,
      this.taskLifecycle,
      this.taskRequestRouting,
      this.observer,
    );
    this.mutationBoundary = new MutationBoundaryService(
      this.database,
      taskRoot,
    );
    const taskBoundFinalization = new TaskBoundFinalizationService(
      this.database,
      taskRoot,
      this.mutationBoundary,
      async (phase, record) => {
        if (phase === "commit_created") {
          this.events.emit({
            level: "info",
            event: "task_commit_created",
            requestId: record.requestId,
            sessionId: record.sessionId,
            runId: record.runId,
            taskId: record.taskId,
            outcome: "succeeded",
            data: { baseHead: record.baseHead, stagedPaths: record.plan.stagedPaths },
          });
          return;
        }
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
    this.runFinalization = new RunFinalizationService({
      database: this.database,
      unbound: new UnboundRunFinalizationService(this.database),
      taskBound: taskBoundFinalization,
    });
    this.startupRunRecovery = new StartupRunRecoveryService(this.database);
    this.taskAttachments = new TaskAttachmentService({
      database: this.database,
      taskRoot,
    });
    this.contextDataCache = new ActiveContextDataCache({
      database: this.database,
      loadReadContext: (sessionId) => buildReadContext(this.database, sessionId),
      loadAttachments: (sessionId) => this.taskAttachments.sessionProjection(sessionId),
      loadTaskCandidates: async (input) => this.taskDiscovery.find({
        limit: input.limit,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.currentText ? { currentText: input.currentText } : {}),
      }).tasks,
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
      loadActiveRun: (sessionId) => this.runs.getActive(sessionId),
      loadActiveTask: async (_sessionId, run) => run.run.taskBinding
        ? await this.taskRequestRouting.projectContext(
            run.run.runId,
            await this.taskLifecycle.readContext(
              (await this.taskLifecycle.getTask({ taskId: run.run.taskBinding.taskId })).task,
            ),
          )
        : undefined,
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
        : await this.assessRequestedTurnRollover(input, input.at);
      const pending = this.turnPreparation.prepare(input, {
        ensureSession: () => this.ensureSessionForTurn(input, input.at, rollover),
      });
      try {
        const receipt = requirePreparedContextTurnReceipt(pending.result);
        this.refreshPreparedSessionCache(receipt.sessionId, rollover?.sessionId);
        const session = await this.sessionRepositoryValidation.ensure(
          receipt.sessionId,
          "request",
        );
        const conversation = readConversation(this.database, receipt.conversationId);
        const message = readConversationMessage(this.database, receipt.messageId);
        const run = readRun(this.database, receipt.runId);
        const persistence = readConversationPersistenceState(
          this.database,
          receipt.conversationId,
        );
        if (!conversation
          || conversation.sessionId !== receipt.sessionId
          || !message
          || message.conversationId !== receipt.conversationId
          || !run
          || run.conversationId !== receipt.conversationId
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
        this.runs.refresh(run.runId);
        const context = await this.activeContextProjection.build(sessionRecord);
        const result: PrepareContextTurnResponse = {
          session,
          sessionCreated: receipt.sessionCreated,
          conversation,
          message,
          run,
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
        this.emitTurnRollover(rollover, result.session, input);
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
          event: "run_started",
          requestId: input.requestId,
          sessionId: session.sessionId,
          conversationId: result.conversation.conversationId,
          runId: result.run.runId,
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

  async createTaskForRun(input: CreateTaskForRunRequest): Promise<SelectedTaskForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskBinding.create(input);
      this.taskDiscovery.recordAccess({
        taskId: result.task.taskId,
        runId: result.run.runId,
        kind: "bound",
        at: input.at,
      });
      this.runs.refresh(result.run.runId);
      this.invalidateContext("run_task_bound", {
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
        allSessions: true,
        taskCandidates: true,
      });
      this.events.taskSelected("created", result);
      this.events.emit({
        level: "info",
        event: result.task.placement === "requested" ? "task_registered" : "task_created",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
        outcome: "succeeded",
        data: {
          placement: result.task.placement,
          repositoryPath: result.task.repositoryPath,
          taskCreated: result.taskCreated,
          registrationHeadBefore: result.task.registrationHeadBefore,
        },
      });
      return result;
    });
  }

  async activateTaskForRun(input: ActivateTaskForRunRequest): Promise<SelectedTaskForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskBinding.activate(input);
      this.taskDiscovery.recordAccess({
        taskId: result.task.taskId,
        runId: result.run.runId,
        kind: "bound",
        at: input.at,
      });
      this.runs.refresh(result.run.runId);
      this.invalidateContext("run_task_bound", {
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
      this.runs.refresh(input.runId);
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
      return this.taskDiscovery.find(input);
    });
  }

  async findTasks(input: FindTasksRequest): Promise<FindTasksResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = this.taskDiscovery.find(input);
      this.events.emit({
        level: "info",
        event: "task_candidates_discovered",
        sessionId: input.sessionId,
        outcome: "succeeded",
        data: {
          count: result.tasks.length,
          view: input.view ?? "relevant",
          queried: Boolean(input.query),
          pathCount: input.paths?.length ?? 0,
          candidates: result.tasks.slice(0, 20).map((task) => ({
            taskId: task.taskId,
            tier: task.discovery.tier,
            reasons: task.discovery.reasons,
          })),
        },
      });
      return result;
    });
  }

  async inspectTaskLocation(
    input: InspectTaskLocationRequest,
  ): Promise<InspectTaskLocationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireWritableSession(input.sessionId);
      const result = await this.taskLocations.inspect(input);
      this.events.emit({
        level: "info",
        event: "task_location_inspected",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        outcome: "succeeded",
        data: {
          kind: result.kind,
          repositoryPath: result.canonicalPath,
          approvalRequired: Boolean(result.registrationApprovalId),
        },
      });
      return result;
    });
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.taskLifecycle.getTask(input);
    });
  }

  async readTask(input: ReadTaskRequest): Promise<ReadTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const run = readRunEvidence(this.database, input.runId);
      if (!run || run.sessionId !== input.sessionId || run.status !== "running") {
        throw new GitContextServiceError({
          code: "RUN_NOT_ACTIVE",
          message: "Opening a task requires the matching active run.",
          details: { sessionId: input.sessionId, runId: input.runId },
        });
      }
      const result = await this.taskLifecycle.getTask({ taskId: input.taskId });
      this.taskDiscovery.recordAccess({
        taskId: input.taskId,
        runId: input.runId,
        kind: "opened",
        at: input.at,
      });
      this.invalidateContext("task_opened", {
        sessionId: input.sessionId,
        taskCandidates: true,
      });
      this.events.emit({
        level: "info",
        event: "task_opened",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "succeeded",
        data: {
          repositoryPath: result.task.repositoryPath,
          repositoryHealth: result.context?.repositoryHealth,
        },
      });
      return { ...result, opened: true };
    });
  }

  async setTaskStar(input: SetTaskStarRequest): Promise<SetTaskStarResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = this.taskDiscovery.setStar(input);
      this.invalidateContext("task_star_changed", {
        sessionId: input.sessionId,
        allSessions: true,
        taskCandidates: true,
      });
      this.events.emit({
        level: "info",
        event: "task_star_changed",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "succeeded",
        data: { starred: input.starred },
      });
      return result;
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
      this.runs.refresh(input.runId);
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

  async finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireSession(input.sessionId);
      const selectedRun = readRun(this.database, input.runId);
      const taskId = selectedRun?.taskBinding?.taskId;
      const selectedTask = taskId
        ? await this.taskLifecycle.getTask({ taskId })
        : undefined;
      let result: FinalizeRunResponse;
      let completed = false;
      this.events.emit({
        level: "info",
        event: "run_finalization_started",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        ...(taskId ? { taskId } : {}),
        outcome: "started",
        data: {
          workingDirectory: selectedTask?.task.workingPath,
          taskRequestId: selectedRun?.taskBinding?.taskRequestId,
          requestedOutcome: input.outcome,
          validation: input.validation,
        },
      });
      try {
        result = await this.runFinalization.finalize(input, session);
        completed = true;
      } catch (error) {
        this.events.emit({
          level: "error",
          event: "run_finalization_failed",
          requestId: input.requestId,
          sessionId: input.sessionId,
          runId: input.runId,
          ...(taskId ? { taskId } : {}),
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (completed) this.runs.remove(input.runId);
        else {
          try {
            this.runs.refresh(input.runId);
          } catch {
            this.runs.remove(input.runId);
          }
        }
        this.conversationCache.refreshSession(this.database, input.sessionId);
        this.invalidateContext("run_finalization", {
          sessionId: input.sessionId,
          runId: input.runId,
          ...(taskId ? { taskId } : {}),
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
        event: "run_finalization_completed",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        ...(taskId ? { taskId } : {}),
        outcome: "succeeded",
        data: {
          outcome: result.run.status,
          stopReason: result.run.stopReason,
          workingDirectory: selectedTask?.task.workingPath,
          taskRequestId: selectedRun?.taskBinding?.taskRequestId,
          materialization: result.materialization,
          commit: result.commit,
          readContextReset: result.commit.status === "committed",
        },
      });
      await this.reconcileLatestDailySession(input.at);
      return result;
    });
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = this.runs.recordStep(input);
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
    this.runs.clear();
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
      if (session) {
        this.conversationCache.refreshSession(this.database, session.sessionId);
      }
      await this.taskLifecycle.recoverInitializingState();
      await this.runFinalization.recover(this.now());
      const runRecovery = this.startupRunRecovery.recover(this.now());
      for (const runId of runRecovery.interruptedRunIds) {
        const run = readRun(this.database, runId);
        this.events.emit({
          level: "warn",
          event: "run_finalization_completed",
          sessionId: run?.sessionId,
          runId,
          outcome: "succeeded",
          data: {
            outcome: "incomplete",
            stopReason: "interrupted",
            recoveredAtStartup: true,
            commit: { status: "not_required" },
          },
        });
      }
      for (const runId of runRecovery.recoveryRequiredRunIds) {
        const run = readRun(this.database, runId);
        this.events.emit({
          level: "error",
          event: "run_finalization_failed",
          sessionId: run?.sessionId,
          runId,
          taskId: run?.taskBinding?.taskId,
          outcome: "failed",
          message: "Startup recovery requires manual resolution before another run can start.",
          data: { recoveredAtStartup: true, runStatus: "recovery_required" },
        });
      }
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

  private async assessRequestedTurnRollover(
    input: PrepareContextTurnRequest,
    at: string,
  ): Promise<TurnRolloverAssessment | undefined> {
    validateSessionInput(input);
    const agentId = normalizeAgentId(input.agentId);
    const existing = readLiveSessionRecords(this.database)
      .find((session) => session.agentId === agentId);
    if (!existing || existing.date === input.date) return undefined;
    verifyExpectedHead(sessionRecordRef(existing), input.expectedHead);
    const action = await this.dailySessionRollover.assess(existing, {
      date: input.date,
      timezone: input.timezone,
      at,
    });
    return { sessionId: existing.sessionId, action };
  }

  /** Runs inside the preparation transaction and intentionally avoids cache mutation. */
  private ensureSessionForTurn(
    input: PrepareContextTurnRequest,
    createdAt: string,
    rollover: TurnRolloverAssessment | undefined,
  ): EnsureActiveSessionResponse {
    validateSessionInput(input);
    const agentId = normalizeAgentId(input.agentId);
    const existing = readLiveSessionRecords(this.database)
      .find((session) => session.agentId === agentId);
    if (existing) {
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
      verifyExpectedHead(sessionRecordRef(existing), input.expectedHead);
      if (existing.date === input.date) {
        return { session: sessionRecordRef(existing), created: false };
      }
      if (!rollover || rollover.sessionId !== existing.sessionId) {
        throw new GitContextServiceError({
          code: "INVALID_REQUEST",
          message: "Daily session rollover changed before turn preparation.",
          details: { sessionId: existing.sessionId, requestedDate: input.date },
        });
      }
      if (rollover.action === "mark_pending") {
        const pending = existing.status === "open"
          ? updateSessionStatus(this.database, existing.sessionId, "rollover_pending", createdAt)
          : existing;
        return { session: sessionRecordRef(pending), created: false };
      }
      if (rollover.action === "seal_and_create") {
        updateSessionStatus(this.database, existing.sessionId, "sealed", createdAt);
        const nextSessionId = "S-" + input.date.replaceAll("-", "") + "-" + agentId;
        return {
          session: insertSession(this.database, {
            sessionId: nextSessionId,
            date: input.date,
            timezone: input.timezone,
            agentId,
            repositoryPath: join(this.dataRoot, "sessions", nextSessionId),
            previousSessionId: existing.sessionId,
            createdAt,
          }),
          created: true,
        };
      }
      throw new Error("Unexpected daily session rollover action for a new date.");
    }

    const sessionId = "S-" + input.date.replaceAll("-", "") + "-" + agentId;
    const previousSessionId = readLatestSealedSessionId(this.database, agentId);
    return {
      session: insertSession(this.database, {
        sessionId,
        date: input.date,
        timezone: input.timezone,
        agentId,
        repositoryPath: join(this.dataRoot, "sessions", sessionId),
        ...(previousSessionId ? { previousSessionId } : {}),
        createdAt,
      }),
      created: true,
    };
  }

  private refreshPreparedSessionCache(
    sessionId: string,
    previousSessionId?: string,
  ): void {
    for (const id of new Set([sessionId, previousSessionId].filter(
      (value): value is string => Boolean(value),
    ))) {
      const record = readSessionRecord(this.database, id);
      if (record) this.sessionRegistry.set(record);
    }
  }

  private emitTurnRollover(
    rollover: TurnRolloverAssessment | undefined,
    session: SessionRef,
    input: PrepareContextTurnRequest,
  ): void {
    if (!rollover || rollover.action === "reuse") return;
    if (rollover.action === "mark_pending") {
      this.events.emit({
        level: "info",
        event: "session_rollover_pending",
        sessionId: rollover.sessionId,
        outcome: "succeeded",
        data: {
          requestedDate: input.date,
          reason: "waiting_for_run_finalization",
        },
      });
      return;
    }
    this.conversationCache.refreshSession(this.database, rollover.sessionId);
    this.events.emit({
      level: "info",
      event: "session_rollover_completed",
      sessionId: session.sessionId,
      outcome: "succeeded",
      data: {
        previousSessionId: rollover.sessionId,
        currentDate: session.date,
        closingCommitCreated: false,
      },
    });
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
