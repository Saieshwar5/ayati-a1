import { join } from "node:path";
import {
  type ActivateWorkstreamForRunRequest,
  type AgentContextProjection,
  type BindResourcesForRunRequest,
  type BindResourcesForRunResponse,
  type CheckpointRunWorkStateRequest,
  type CheckpointRunWorkStateResponse,
  type CommitContextCheckpointRequest,
  type CommitContextCheckpointResponse,
  type ContextCheckpointPlan,
  type ContextCheckpointRecord,
  type CreateWorkstreamForRunRequest,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type FindResourcesRequest,
  type FindResourcesResponse,
  type FindWorkstreamsRequest,
  type FindWorkstreamsResponse,
  type GetAgentContextRequest,
  type GetWorkstreamRequest,
  type GetWorkstreamResponse,
  type ContextEngineHealth,
  type InspectResourceForRunRequest,
  type InspectResourceForRunResponse,
  type ListWorkstreamsRequest,
  type ListWorkstreamsResponse,
  type PlanContextCheckpointRequest,
  type PlanWorkstreamRequestRouteRequest,
  type PlanWorkstreamRequestRouteResponse,
  type PrepareAgentRunRequest,
  type PrepareAgentRunResponse,
  type PrepareResourceMutationRequest,
  type PrepareResourceMutationResponse,
  type ReadAgentConversationRequest,
  type ReadAgentConversationResponse,
  type ReadAgentHistoryRequest,
  type ReadAgentHistoryResponse,
  type ReadWorkstreamRequest,
  type ReadWorkstreamResponse,
  type ReadWorkstreamRepositoryCommitRequest,
  type ReadWorkstreamRepositoryCommitResponse,
  type ReadWorkstreamRepositoryDiffRequest,
  type ReadWorkstreamRepositoryDiffResponse,
  type ReadWorkstreamRepositoryLogRequest,
  type ReadWorkstreamRepositoryLogResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type SearchAgentHistoryRequest,
  type SearchAgentHistoryResponse,
  type SelectedWorkstreamForRunResponse,
  type SetWorkstreamStarRequest,
  type SetWorkstreamStarResponse,
  type VerifyResourceMutationRequest,
  type VerifyResourceMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  executeIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
  readCompletedIdempotent,
  updateRecoverableIdempotentResult,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import { ContextEngineObserver } from "../observability.js";
import {
  ensureAgentStream,
  readAgentStream,
} from "../repositories/agent-stream-records.js";
import { readStreamMessage } from "../repositories/message-records.js";
import {
  readRun,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readRecentRequestProgress } from "../repositories/workstream-progress-records.js";
import { refreshWorkstreamDiscoveryProjection } from "../repositories/workstream-discovery-records.js";
import type { ContextEngineService } from "../service.js";
import { SerializedWriteQueue } from "../write-queue.js";
import { AgentContextProjectionService } from "./agent-context-projection-service.js";
import { AgentHistoryService } from "./agent-history-service.js";
import { ContextCheckpointService } from "./context-checkpoint-service.js";
import {
  completePreparedAgentRunReceipt,
  requirePreparedAgentRunReceipt,
} from "./prepared-agent-run-receipt.js";
import { ResourceCatalogService } from "./resource-catalog-service.js";
import { ResourceMutationService } from "./resource-mutation-service.js";
import { RunFinalizationService } from "./run-finalization-service.js";
import { RunLifecycleService } from "./run-lifecycle-service.js";
import { StartupRunRecoveryService } from "./startup-run-recovery-service.js";
import { TurnPreparationService } from "./turn-preparation-service.js";
import { UnboundRunFinalizationService } from "./unbound-run-finalization-service.js";
import { WorkstreamBindingService } from "./workstream-binding-service.js";
import { WorkstreamBoundFinalizationService } from "./workstream-bound-finalization-service.js";
import { WorkstreamDiscoveryService } from "./workstream-discovery-service.js";
import { WorkstreamLifecycleService } from "./workstream-lifecycle-service.js";
import { WorkstreamRequestRoutingService } from "./workstream-request-routing-service.js";
import { WorkstreamRepositoryInspectionService } from "./workstream-repository-inspection-service.js";

export interface SqliteContextEngineServiceOptions {
  database: ContextDatabase;
  rootDirectory: string;
  now?: () => string;
  observer?: ContextEngineObserver;
}

export class SqliteContextEngineService implements ContextEngineService {
  private readonly database: ContextDatabase;
  private readonly now: () => string;
  private readonly observer: ContextEngineObserver;
  private readonly queue = new SerializedWriteQueue();
  private readonly turnPreparation: TurnPreparationService;
  private readonly runs: RunLifecycleService;
  private readonly workstreamLifecycle: WorkstreamLifecycleService;
  private readonly workstreamDiscovery: WorkstreamDiscoveryService;
  private readonly workstreamRequestRouting: WorkstreamRequestRoutingService;
  private readonly workstreamBinding: WorkstreamBindingService;
  private readonly resourceCatalog: ResourceCatalogService;
  private readonly resourceMutations: ResourceMutationService;
  private readonly runFinalization: RunFinalizationService;
  private readonly startupRunRecovery: StartupRunRecoveryService;
  private readonly agentContext: AgentContextProjectionService;
  private readonly checkpoints: ContextCheckpointService;
  private readonly history: AgentHistoryService;
  private readonly workstreamRepositoryInspection: WorkstreamRepositoryInspectionService;
  private closed = false;
  private startupRecovered = false;

  constructor(options: SqliteContextEngineServiceOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date().toISOString());
    this.observer = options.observer ?? new ContextEngineObserver("context-engine");
    this.turnPreparation = new TurnPreparationService(this.database);
    this.runs = new RunLifecycleService(this.database);
    const workstreamRoot = join(options.rootDirectory, "workstreams");
    this.resourceCatalog = new ResourceCatalogService({
      database: this.database,
      rootDirectory: options.rootDirectory,
    });
    this.resourceMutations = new ResourceMutationService(this.database);
    this.workstreamDiscovery = new WorkstreamDiscoveryService(this.database, this.now);
    this.workstreamLifecycle = new WorkstreamLifecycleService({
      database: this.database,
      workstreamRoot,
      now: this.now,
      onContextRead: (workstream, context) => {
        refreshWorkstreamDiscoveryProjection({ database: this.database, workstream, context });
      },
    });
    this.workstreamRequestRouting = new WorkstreamRequestRoutingService({
      database: this.database,
      workstreamRoot,
    });
    this.workstreamBinding = new WorkstreamBindingService(
      this.database,
      this.workstreamLifecycle,
      this.workstreamRequestRouting,
      this.observer,
    );
    const unboundFinalization = new UnboundRunFinalizationService(this.database);
    const workstreamBound = new WorkstreamBoundFinalizationService(
      this.database,
      workstreamRoot,
      this.resourceCatalog,
      unboundFinalization,
      async (phase, record) => {
        this.observer.emit({
          level: "info",
          event: phase === "commit_created"
            ? "workstream_context_commit_created"
            : "workstream_context_plan_persisted",
          requestId: record.operationRequestId,
          streamId: record.streamId,
          runId: record.runId,
          workstreamId: record.workstreamId,
          outcome: "succeeded",
          data: { baseHead: record.baseHead, stagedPaths: record.plan.stagedPaths },
        });
      },
    );
    this.runFinalization = new RunFinalizationService({
      database: this.database,
      unbound: unboundFinalization,
      workstreamBound,
    });
    this.startupRunRecovery = new StartupRunRecoveryService(this.database);
    this.agentContext = new AgentContextProjectionService({
      database: this.database,
      loadActiveWorkstream: async (run) => {
        const binding = run.run.workstreamBinding;
        if (!binding) return undefined;
        const selected = await this.workstreamLifecycle.getWorkstream({
          workstreamId: binding.workstreamId,
        });
        if (!selected.context) return undefined;
        const context = await this.workstreamRequestRouting.projectContext(
          run.run.runId,
          selected.context,
        );
        const recentProgress = readRecentRequestProgress(this.database, {
          workstreamId: binding.workstreamId,
          requestId: binding.requestId,
          limit: 5,
        }).map((entry) => ({
          runId: entry.runId,
          outcome: entry.outcome,
          summary: entry.summary,
          validationSummary: entry.validationSummary,
          ...(entry.nextAction ? { nextAction: entry.nextAction } : {}),
          commit: entry.commit,
          finalizedAt: entry.finalizedAt,
        }));
        return {
          ...context,
          recentProgress,
          resources: this.resourceCatalog.readWorkstreamBindings(binding.workstreamId),
        };
      },
      loadFocusedWorkstream: async (stream) => {
        if (!stream.focusedWorkstreamId || !stream.focusedRequestId) return undefined;
        try {
          const selected = await this.workstreamLifecycle.getWorkstreamRequestContext({
            workstreamId: stream.focusedWorkstreamId,
            requestId: stream.focusedRequestId,
          });
          const context = selected.context;
          const request = context?.selectedRequest;
          if (!context || !request
            || context.lifecycleStatus !== "active"
            || request.status === "done"
            || request.status === "dropped") {
            return undefined;
          }
          return {
            ...context,
            resources: this.resourceCatalog.readWorkstreamBindings(stream.focusedWorkstreamId),
          };
        } catch (error) {
          if (error instanceof ContextEngineServiceError
            && (error.code === "NOT_FOUND" || error.code === "WORKSTREAM_NOT_FOUND")) {
            return undefined;
          }
          throw error;
        }
      },
      loadWorkstreamCandidates: async (input) => this.workstreamDiscovery.find({
        streamId: input.streamId,
        ...(input.currentText ? { currentText: input.currentText } : {}),
        limit: 5,
      }).workstreams,
    });
    this.checkpoints = new ContextCheckpointService(this.database);
    this.history = new AgentHistoryService(this.database);
    this.workstreamRepositoryInspection = new WorkstreamRepositoryInspectionService({
      database: this.database,
      workstreamRoot,
    });
  }

  async getHealth(): Promise<ContextEngineHealth> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const ready = this.database.schemaVersion() === this.database.expectedSchemaVersion();
      return {
        service: "ayati-context-engine",
        status: ready ? "ok" : "degraded",
        ready,
        capabilities: [
          "health",
          "agent_context",
          "agent_streams",
          "checkpoints",
          "history",
          "runs",
          "workstreams",
          "resources",
          "mutations",
          "recovery",
        ],
      };
    });
  }

  async getAgentContext(input: GetAgentContextRequest): Promise<AgentContextProjection> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.agentContext.build(normalizeContextLookup(input));
    });
  }

  async prepareAgentRun(input: PrepareAgentRunRequest): Promise<PrepareAgentRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const normalizedInput = normalizePreparation(input);
      const existingRequest = hasRecoverableIdempotencyRequest({
        database: this.database,
        requestId: normalizedInput.requestId,
        operation: "prepare_agent_run",
        payload: normalizedInput,
      });
      const resources = existingRequest
        ? []
        : await this.resourceCatalog.normalizeIngressAdmissions(
            normalizedInput.resources,
            normalizedInput.at,
          );
      const pending = this.turnPreparation.prepare(normalizedInput, {
        ensureStream: () => ensureAgentStream(this.database, {
          agentId: normalizedInput.agentId,
          scopeKey: normalizedInput.scopeKey ?? "default",
          at: normalizedInput.at,
        }),
        admitResources: ({ messageId, runId }) => {
          this.resourceCatalog.admitPreparedTurn({
            messageId,
            runId,
            admissions: resources,
            at: normalizedInput.at,
          });
        },
      });
      try {
        const receipt = requirePreparedAgentRunReceipt(pending.result);
        const stream = readAgentStream(this.database, receipt.streamId);
        const message = readStreamMessage(this.database, receipt.messageId);
        const run = readRun(this.database, receipt.runId);
        if (!stream || !message || !run
          || message.streamId !== stream.streamId
          || run.streamId !== stream.streamId) {
          throw new Error("Prepared agent-run receipt does not resolve to durable Context Engine records.");
        }
        this.runs.refresh(run.runId);
        const context = await this.agentContext.build({
          streamId: stream.streamId,
          currentText: normalizedInput.content,
        });
        if (!pending.completed) {
          completeRecoverableIdempotent({
            database: this.database,
            requestId: normalizedInput.requestId,
            result: completePreparedAgentRunReceipt(receipt, context.contextRevision),
            now: normalizedInput.at,
          });
          this.observer.emit({
            level: "info",
            event: "agent_run_started",
            requestId: normalizedInput.requestId,
            streamId: stream.streamId,
            runId: run.runId,
            outcome: "succeeded",
            data: {
              role: normalizedInput.role,
              streamCreated: receipt.streamCreated,
              messageSequence: message.sequence,
              contextRevision: context.contextRevision,
            },
          });
        }
        return {
          stream,
          streamCreated: receipt.streamCreated,
          message,
          run,
          context,
        };
      } catch (error) {
        markRecoverableIdempotencyFailed({
          database: this.database,
          requestId: normalizedInput.requestId,
        });
        throw error;
      }
    });
  }

  async planContextCheckpoint(input: PlanContextCheckpointRequest): Promise<ContextCheckpointPlan> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.checkpoints.plan(input);
    });
  }

  async commitContextCheckpoint(
    input: CommitContextCheckpointRequest,
  ): Promise<CommitContextCheckpointResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const checkpoint = executeIdempotent<ContextCheckpointRecord>({
        database: this.database,
        requestId: input.requestId,
        operation: "commit_context_checkpoint",
        payload: input,
        now: input.at,
        execute: () => this.checkpoints.commit(input),
      });
      const context = await this.agentContext.build({ streamId: checkpoint.streamId });
      this.observer.emit({
        level: "info",
        event: "context_checkpoint_committed",
        requestId: input.requestId,
        streamId: checkpoint.streamId,
        outcome: "succeeded",
        data: {
          checkpointId: checkpoint.checkpointId,
          coveredFromSeq: checkpoint.coveredFromSeq,
          coveredToSeq: checkpoint.coveredToSeq,
          tokenCount: checkpoint.tokenCount,
        },
      });
      return { checkpoint, context };
    });
  }

  async searchAgentHistory(input: SearchAgentHistoryRequest): Promise<SearchAgentHistoryResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.history.search(input);
    });
  }

  async readAgentConversation(
    input: ReadAgentConversationRequest,
  ): Promise<ReadAgentConversationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.history.readConversation(input);
    });
  }

  async readAgentHistory(input: ReadAgentHistoryRequest): Promise<ReadAgentHistoryResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.history.read(input);
    });
  }

  async createWorkstreamForRun(
    input: CreateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.createWorkstreamSelection(input);
    });
  }

  async activateWorkstreamForRun(
    input: ActivateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return await this.activateWorkstreamSelection(input);
    });
  }

  async planWorkstreamRequestRoute(
    input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      const result = await this.workstreamRequestRouting.plan(input);
      this.runs.refresh(input.runId);
      return result;
    });
  }

  async listWorkstreams(input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.workstreamDiscovery.find(input);
    });
  }

  async findWorkstreams(input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.workstreamDiscovery.find(input);
    });
  }

  async getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const result = await this.workstreamLifecycle.getWorkstream(input);
      const resources = this.resourceCatalog.readWorkstreamBindings(input.workstreamId);
      return {
        ...result,
        ...(result.context ? { context: { ...result.context, resources } } : {}),
      };
    });
  }

  async readWorkstream(input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const replay = readCompletedIdempotent<ReadWorkstreamResponse>({
        database: this.database,
        requestId: input.requestId,
        operation: "read_workstream",
        payload: input,
      });
      if (replay) return replay;
      this.requireActiveRun(input.runId);
      const selected = input.workstreamRequestId
        ? await this.workstreamLifecycle.getWorkstreamRequestContext({
            workstreamId: input.workstreamId,
            requestId: input.workstreamRequestId,
          })
        : await this.workstreamLifecycle.getWorkstream({
            workstreamId: input.workstreamId,
          });
      const resources = this.resourceCatalog.readWorkstreamBindings(input.workstreamId);
      return executeIdempotent<ReadWorkstreamResponse>({
        database: this.database,
        requestId: input.requestId,
        operation: "read_workstream",
        payload: input,
        now: input.at,
        execute: () => {
          this.workstreamDiscovery.recordAccess({
            workstreamId: input.workstreamId,
            runId: input.runId,
            kind: "opened",
            at: input.at,
          });
          return {
            ...selected,
            ...(selected.context ? { context: { ...selected.context, resources } } : {}),
            opened: true,
          };
        },
      });
    });
  }

  async readWorkstreamRepositoryLog(
    input: ReadWorkstreamRepositoryLogRequest,
  ): Promise<ReadWorkstreamRepositoryLogResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      return await this.workstreamRepositoryInspection.readLog(input);
    });
  }

  async readWorkstreamRepositoryCommit(
    input: ReadWorkstreamRepositoryCommitRequest,
  ): Promise<ReadWorkstreamRepositoryCommitResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      return await this.workstreamRepositoryInspection.readCommit(input);
    });
  }

  async readWorkstreamRepositoryDiff(
    input: ReadWorkstreamRepositoryDiffRequest,
  ): Promise<ReadWorkstreamRepositoryDiffResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      return await this.workstreamRepositoryInspection.readDiff(input);
    });
  }

  async setWorkstreamStar(input: SetWorkstreamStarRequest): Promise<SetWorkstreamStarResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.workstreamDiscovery.setStar(input);
    });
  }

  async findResources(input: FindResourcesRequest): Promise<FindResourcesResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      return this.resourceCatalog.find(input);
    });
  }

  async inspectResourceForRun(
    input: InspectResourceForRunRequest,
  ): Promise<InspectResourceForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      return await this.resourceCatalog.inspect(input);
    });
  }

  async bindResourcesForRun(
    input: BindResourcesForRunRequest,
  ): Promise<BindResourcesForRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      return this.resourceCatalog.bind(input);
    });
  }

  async prepareResourceMutation(
    input: PrepareResourceMutationRequest,
  ): Promise<PrepareResourceMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      const pending = beginRecoverableIdempotent<PrepareResourceMutationResponse | null>({
        database: this.database,
        requestId: input.requestId,
        operation: "prepare_resource_mutation",
        payload: input,
        now: input.at,
        execute: () => null,
      });
      if (pending.completed) {
        if (!pending.result) throw new Error("Completed mutation preparation receipt is invalid.");
        const authority = this.resourceMutations.operationContext(pending.result.operationId);
        if (authority?.operationStatus !== "prepared" || authority.leaseStatus !== "active") {
          throw new ContextEngineServiceError({
            code: "RECOVERY_REQUIRED",
            message: "The replayed mutation authority is no longer active.",
            details: { operationId: pending.result.operationId },
          });
        }
        return pending.result;
      }
      if (pending.status === "recovery_required" || pending.result) {
        throw new ContextEngineServiceError({
          code: "RECOVERY_REQUIRED",
          message: "Resource mutation preparation was interrupted after authority allocation.",
          details: { requestId: input.requestId, runId: input.runId, callId: input.callId },
        });
      }
      try {
        const result = await this.resourceMutations.prepare(input, (prepared) => {
          updateRecoverableIdempotentResult({
            database: this.database,
            requestId: input.requestId,
            result: prepared,
          });
        });
        completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result,
          now: input.at,
        });
        return result;
      } catch (error) {
        markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
        throw error;
      }
    });
  }

  async verifyResourceMutation(
    input: VerifyResourceMutationRequest,
  ): Promise<VerifyResourceMutationResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      const replay = readCompletedIdempotent<VerifyResourceMutationResponse>({
        database: this.database,
        requestId: input.requestId,
        operation: "verify_resource_mutation",
        payload: input,
      });
      if (replay) return replay;
      const result = await this.resourceMutations.verify(input);
      const persisted = executeIdempotent({
        database: this.database,
        requestId: input.requestId,
        operation: "verify_resource_mutation",
        payload: input,
        now: input.at,
        execute: () => result,
      });
      return persisted;
    });
  }

  async finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireRun(input.runId);
      this.observer.emit({
        level: "info",
        event: "run_finalization_started",
        requestId: input.requestId,
        streamId: readRun(this.database, input.runId)?.streamId,
        runId: input.runId,
        outcome: "started",
        data: { requestedOutcome: input.outcome, stopReason: input.stopReason },
      });
      try {
        const result = await this.runFinalization.finalize(input);
        this.runs.remove(input.runId);
        this.observer.emit({
          level: "info",
          event: "run_finalization_completed",
          requestId: input.requestId,
          streamId: result.run.streamId,
          runId: input.runId,
          workstreamId: result.run.workstreamBinding?.workstreamId,
          outcome: "succeeded",
          data: {
            outcome: result.run.status,
            stopReason: result.run.stopReason,
            resourceEffects: result.resourceEffects,
            workstreamContextCommit: result.workstreamContextCommit,
          },
        });
        return result;
      } catch (error) {
        try {
          this.runs.refresh(input.runId);
        } catch {
          this.runs.remove(input.runId);
        }
        throw error;
      }
    });
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      const response = this.runs.recordStep(input);
      const context = await this.agentContext.build({
        streamId: response.run.run.streamId,
      });
      return { ...response, context };
    });
  }

  async checkpointRunWorkState(
    input: CheckpointRunWorkStateRequest,
  ): Promise<CheckpointRunWorkStateResponse> {
    return await this.queue.enqueue(async () => {
      await this.ensureStartupRecovery();
      this.requireActiveRun(input.runId);
      const response = this.runs.checkpointWorkState(input);
      const context = await this.agentContext.build({
        streamId: response.run.run.streamId,
      });
      return { ...response, context };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.close();
    this.runs.clear();
    this.database.close();
  }

  private async createWorkstreamSelection(
    input: CreateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    this.requireActiveRun(input.runId);
    this.resourceCatalog.validateBindings(input.resources);
    let result = await this.workstreamBinding.create(input);
    if (input.resources && input.resources.length > 0) {
      this.resourceCatalog.bind({
        requestId: input.requestId + ":resources",
        runId: input.runId,
        workstreamId: result.workstream.workstreamId,
        bindings: input.resources,
        at: input.at,
      });
    }
    const resourceBindings = this.resourceCatalog.readWorkstreamBindings(
      result.workstream.workstreamId,
    );
    result = {
      ...result,
      resourceBindings,
      context: { ...result.context, resources: resourceBindings },
    };
    this.workstreamDiscovery.recordAccess({
      workstreamId: result.workstream.workstreamId,
      runId: result.run.runId,
      kind: "bound",
      at: input.at,
    });
    this.runs.refresh(result.run.runId);
    return result;
  }

  private async activateWorkstreamSelection(
    input: ActivateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    this.requireActiveRun(input.runId);
    const selected = await this.workstreamBinding.activate(input);
    const resourceBindings = this.resourceCatalog.readWorkstreamBindings(input.workstreamId);
    const result = {
      ...selected,
      resourceBindings,
      context: { ...selected.context, resources: resourceBindings },
    };
    this.workstreamDiscovery.recordAccess({
      workstreamId: result.workstream.workstreamId,
      runId: result.run.runId,
      kind: "bound",
      at: input.at,
    });
    this.runs.refresh(result.run.runId);
    return result;
  }

  private async ensureStartupRecovery(): Promise<void> {
    if (this.startupRecovered) return;
    await this.workstreamLifecycle.recoverInitializingState();
    this.resourceMutations.recoverInterrupted(this.now());
    await this.runFinalization.recover(this.now());
    const recovered = this.startupRunRecovery.recover(this.now());
    this.startupRecovered = true;
    this.observer.emit({
      level: "info",
      event: "startup_recovery_completed",
      outcome: "succeeded",
      data: {
        interruptedRunIds: recovered.interruptedRunIds,
        recoveryRequiredRunIds: recovered.recoveryRequiredRunIds,
      },
    });
  }

  private requireActiveRun(runId: string): NonNullable<ReturnType<typeof readRunEvidence>> {
    const run = readRunEvidence(this.database, runId);
    if (!run || run.status !== "running") {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Operation requires the matching active run.",
        details: { runId },
      });
    }
    return run;
  }

  private requireRun(runId: string): void {
    if (!readRunEvidence(this.database, runId)) {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Run does not exist.",
        details: { runId },
      });
    }
  }
}

function normalizePreparation(input: PrepareAgentRunRequest): PrepareAgentRunRequest {
  return {
    ...input,
    agentId: normalizeIdentity(input.agentId, "agentId"),
    scopeKey: normalizeIdentity(input.scopeKey ?? "default", "scopeKey"),
  };
}

function normalizeContextLookup(input: GetAgentContextRequest): GetAgentContextRequest {
  if (input.currentText !== undefined
    && (typeof input.currentText !== "string" || input.currentText.length > 20_000)) {
    throw new ContextEngineServiceError({
      code: "INVALID_REQUEST",
      message: "currentText must be a string of at most 20,000 characters.",
    });
  }
  return {
    ...(input.streamId ? { streamId: input.streamId.trim() } : {}),
    ...(input.agentId ? { agentId: normalizeIdentity(input.agentId, "agentId") } : {}),
    ...(input.scopeKey ? { scopeKey: normalizeIdentity(input.scopeKey, "scopeKey") } : {}),
    ...(input.currentText !== undefined ? { currentText: input.currentText } : {}),
  };
}

function normalizeIdentity(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!normalized || normalized.length > 200) {
    throw new ContextEngineServiceError({
      code: "INVALID_REQUEST",
      message: field + " must resolve to a bounded stable identity.",
    });
  }
  return normalized;
}
