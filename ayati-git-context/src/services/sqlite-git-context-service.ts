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
  type CheckpointMutationRequest,
  type CheckpointMutationResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
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
  type MountTaskRequest,
  type MountTaskResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordSessionAttachmentsRequest,
  type RecordSessionAttachmentsResponse,
  type SessionRef,
  type SnapshotTaskRunEvidenceRequest,
  type SnapshotTaskRunEvidenceResponse,
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
import { TaskAttachmentService } from "./task-attachment-service.js";
import { SessionRegistryCache } from "./session-registry-cache.js";
import { ConversationHotCache } from "./conversation-hot-cache.js";
import {
  normalizeAgentId,
  validateSessionInput,
  verifyExpectedHead,
} from "./session-policy.js";
import { SessionSummaryHotCache } from "./session-summary-hot-cache.js";
import { SessionRunLifecycleService } from "./session-run-lifecycle-service.js";
import { TaskRunSelectionService } from "./task-run-selection-service.js";
import { readTaskMount } from "../repositories/task-mount-records.js";
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
}

export class SqliteGitContextService implements GitContextService {
  private readonly database: ContextDatabase;
  private readonly dataRoot: string;
  private readonly now: () => string;
  private readonly observer: GitContextObserver;
  private readonly events: GitContextServiceObservability;
  private readonly queue = new SerializedWriteQueue();
  private readonly contextCache = new ActiveContextCache();
  private readonly sessionRegistry: SessionRegistryCache;
  private readonly conversationCache: ConversationHotCache;
  private readonly sessionSummaryCache = new SessionSummaryHotCache();
  private readonly sessionRuns: SessionRunLifecycleService;
  private readonly taskLifecycle: TaskLifecycleService;
  private readonly taskSelection: TaskRunSelectionService;
  private readonly mutationBoundary: MutationBoundaryService;
  private readonly taskCheckpoint: TaskCheckpointService;
  private readonly taskRunEvidence: TaskRunEvidenceService;
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
    this.sessionRuns = new SessionRunLifecycleService(this.database);
    const workspaceRoot = options.workspaceRoot ?? join(this.dataRoot, "workspace");
    this.taskLifecycle = new TaskLifecycleService({
      database: this.database,
      dataRoot: this.dataRoot,
      workspaceRoot,
      now: this.now,
    });
    this.taskSelection = new TaskRunSelectionService(
      this.database,
      this.taskLifecycle,
      this.sessionRuns,
      this.observer,
    );
    this.mutationBoundary = new MutationBoundaryService(
      this.database,
      join(workspaceRoot, "tasks"),
    );
    this.taskCheckpoint = new TaskCheckpointService(this.database);
    this.taskRunEvidence = new TaskRunEvidenceService(this.database);
    this.taskRunFinalization = new TaskRunFinalizationService(
      this.database,
      join(workspaceRoot, "tasks"),
    );
    this.taskAttachments = new TaskAttachmentService({
      database: this.database,
      taskRoot: join(workspaceRoot, "tasks"),
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
      const startedAt = Date.now();
      await this.ensureStartupRecovery();
      const sessionRecord = input.sessionId
        ? this.sessionRegistry.getSession(this.database, input.sessionId)
        : this.sessionRegistry.getLatestLiveSession();
      if (!sessionRecord) {
        return {
          contextRevision: activeContextRevision({
            head: null,
            status: "unavailable",
            conversations: [],
            taskCandidates: [],
          }).revision,
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
      const taskCandidates = this.taskLifecycle.listTasks({ limit: 20 }).tasks;
      const readContext = buildReadContext(this.database, session.sessionId);
      const attachments = this.taskAttachments.sessionProjection(session.sessionId);
      const { revision, pendingDigest } = activeContextRevision({
        head: session.head,
        status: session.status,
        conversations,
        readContext,
        ...(attachments ? { attachments } : {}),
        ...(run ? { run } : {}),
        taskCandidates,
      });
      const cached = this.contextCache.get(session.sessionId, revision);
      if (cached) {
        this.events.cacheHit(session.sessionId, revision);
        return cached;
      }
      const previousRevision = this.contextCache.latestRevision(session.sessionId);
      this.events.cacheMiss(session.sessionId, revision, previousRevision);
      const context: ActiveContext = {
        contextRevision: revision,
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
          ...(attachments ? { attachments } : {}),
        },
        ...(run
          ? {
              run,
            }
          : {}),
        ...(run?.run.taskId
          ? {
              activeTask: await this.taskLifecycle.readContext(
                (await this.taskLifecycle.getTask({ taskId: run.run.taskId })).task,
                readTaskMount(this.database, session.sessionId, run.run.taskId)?.workingPath,
              ),
            }
          : {}),
        readContext,
        taskCandidates,
        warnings: [],
      };
      this.contextCache.set(session.sessionId, revision, context);
      this.events.cacheBuilt(context, Date.now() - startedAt, previousRevision);
      return context;
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
        const session = await this.ensureRepositoryForSession(
          pending.result.session.sessionId,
        );
        const result: EnsureActiveSessionResponse = {
          session,
          created: pending.result.created || rollover?.created === true,
        };
        this.invalidateContext("session_ensured", { sessionId: session.sessionId });
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
        const taskCandidates = this.taskLifecycle.listTasks({ limit: 20 }).tasks;
        const readContext = buildReadContext(this.database, input.sessionId);
        const attachments = this.taskAttachments.sessionProjection(input.sessionId);
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

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskLifecycle.createTask(input);
      this.invalidateContext("task_created", { sessionId: input.sessionId, taskId: result.task.taskId });
      this.events.emit({
        level: "info",
        event: "task_repository_created",
        requestId: input.requestId,
        sessionId: input.sessionId,
        taskId: result.task.taskId,
        outcome: "succeeded",
        data: { created: result.created, title: result.task.title, taskHead: result.task.head },
      });
      return result;
    });
  }

  async createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskSelection.create(input, session);
      this.sessionRuns.refresh(result.run.runId);
      this.invalidateContext("task_run_created", {
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
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
      const result = await this.taskSelection.activate(input, session);
      this.sessionRuns.refresh(result.run.runId);
      this.invalidateContext("task_run_activated", {
        sessionId: input.sessionId,
        runId: result.run.runId,
        taskId: result.task.taskId,
      });
      this.events.taskSelected("activated", result);
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

  async mountTask(input: MountTaskRequest): Promise<MountTaskResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      const result = await this.taskLifecycle.mountTask(input, session);
      this.invalidateContext("task_mounted", { sessionId: input.sessionId, taskId: input.taskId });
      this.events.emit({
        level: "info",
        event: "task_mounted",
        requestId: input.requestId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        outcome: "succeeded",
        data: {
          created: result.created,
          checkoutPath: result.mount.checkoutPath,
          workingPath: result.mount.workingPath,
          mountedHead: result.mount.mountedHead,
        },
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
      this.invalidateContext("task_reference_adopted", {
        runId: result.runId,
        taskId: result.taskId,
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
      const result = await this.mutationBoundary.acquire(input, session);
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
      const result = await this.mutationBoundary.verify(input);
      this.invalidateContext("mutation_verified", {});
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

  async checkpointMutation(
    input: CheckpointMutationRequest,
  ): Promise<CheckpointMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = await this.taskCheckpoint.checkpoint(input);
      this.invalidateContext("task_mutation_staged", {
        runId: result.runId,
        taskId: result.taskId,
      });
      this.events.emit({
        level: "info",
        event: "task_mutation_staged",
        requestId: input.requestId,
        runId: result.runId,
        taskId: result.taskId,
        outcome: "succeeded",
        data: {
          authorityId: input.authorityId,
          baseHead: result.beforeHead,
          stagedPaths: result.stagedPaths,
          purpose: input.purpose,
        },
      });
      return result;
    });
  }

  async snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireWritableSession(input.sessionId);
      verifyExpectedHead(session, input.expectedHead);
      return await this.taskRunEvidence.snapshot(input, session);
    });
  }

  async finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const session = this.requireSession(input.sessionId);
      let result: FinalizeTaskRunResponse;
      this.events.emit({
        level: "info",
        event: "task_finalization_started",
        requestId: input.requestId,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        outcome: "started",
        data: { requestedOutcome: input.outcome, validation: input.validation },
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
          taskHeadBefore: result.taskHeadBefore,
          taskHeadAfter: result.taskHeadAfter,
          taskCommit: result.taskFinalizationCommit,
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
      this.invalidateContext("run_step_persisted", { sessionId: input.sessionId, runId: input.runId });
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
    this.database.close();
  }

  private async ensureStartupRecovery(): Promise<void> {
    if (this.startupRecovered) return;
    const startedAt = Date.now();
    this.events.emit({ level: "info", event: "startup_recovery_started", outcome: "started" });
    try {
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
    this.invalidateContext("session_head_changed", { sessionId });
    const updated = updateSessionHead(this.database, sessionId, head);
    this.sessionRegistry.updateHead(sessionId, head);
    await this.sessionSummaryCache.refresh(updated);
    return updated;
  }

  private invalidateContext(
    reason: string,
    input: { sessionId?: string; runId?: string; taskId?: string },
  ): void {
    const previousRevision = input.sessionId
      ? this.contextCache.latestRevision(input.sessionId)
      : undefined;
    this.contextCache.clear();
    this.events.cacheInvalidated(reason, { ...input, previousRevision });
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
      return await this.ensureRepositoryForSession(result.session.sessionId);
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
      await this.ensureRepositoryForSession(result.session.sessionId);
    }
    return result;
  }

  private startRolloverTimer(): void {
    if (this.rolloverTimer || this.closed || this.rolloverCheckIntervalMs <= 0) return;
    this.rolloverTimer = setInterval(() => {
      if (this.closed) return;
      void this.queue.enqueue(async () => {
        await this.reconcileLatestDailySession(this.now());
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
