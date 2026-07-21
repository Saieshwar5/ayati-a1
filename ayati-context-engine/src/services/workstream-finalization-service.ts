import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  RunOutcome,
  RunWorkState,
  WorkstreamCompletionRecord,
  WorkstreamResourceBinding,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  commitWorkstreamContextPlan,
  contentHash,
  recognizeCommittedWorkstreamContextPlan,
} from "../git/workstream-context-transaction.js";
import { appendStreamMessage, readRunMessages } from "../repositories/message-records.js";
import { readReusableObservationProjection } from "../repositories/reusable-observation-records.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readRunWorkState, replaceRunWorkState } from "../repositories/run-work-state-records.js";
import {
  insertWorkstreamFinalization,
  readRecoverableWorkstreamFinalizations,
  readWorkstreamFinalization,
  updateWorkstreamFinalization,
  type WorkstreamContextCommitPlan,
  type WorkstreamFinalizationRecord,
} from "../repositories/workstream-finalization-records.js";
import { readResourceEventsForRun } from "../repositories/resource-records.js";
import {
  readWorkstreamInitialization,
  updateWorkstreamHead,
} from "../repositories/workstream-records.js";
import { writeWorkstreamDiscoveryProjection } from "../repositories/workstream-discovery-records.js";
import {
  readWorkstreamRequestRoutePlan,
  updateWorkstreamRequestRoutePlan,
} from "../repositories/workstream-request-route-plan-records.js";
import { resolvePlannedWorkstreamRequestState } from "../workstreams/planned-workstream-request.js";
import {
  renderWorkstreamCommit,
  type WorkstreamCommitOutcome,
} from "../workstreams/workstream-commit-metadata.js";
import { reduceSimpleWorkstreamContext } from "../workstreams/simple-workstream-context-reducer.js";
import { WORKSTREAM_RESOURCES_PATH } from "../workstreams/workstream-repository-layout.js";
import {
  renderWorkstreamResourceManifest,
  WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
} from "../workstreams/workstream-resource-manifest.js";
import {
  validateWorkstreamRepository,
  type WorkstreamRepositoryValidation,
} from "../workstreams/workstream-repository-validator.js";
import type { ResourceCatalogService } from "./resource-catalog-service.js";

export type WorkstreamFinalizationHook = (
  phase: "plan_persisted" | "commit_created",
  record: WorkstreamFinalizationRecord,
) => void | Promise<void>;

interface BoundFinalizeInput extends Omit<FinalizeRunRequest, "workstream"> {
  workstreamId: string;
  boundRequestId: string;
  completion: WorkstreamCompletionRecord;
}

export class WorkstreamFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    workstreamRoot: string;
    resourceCatalog: ResourceCatalogService;
    hook?: WorkstreamFinalizationHook;
  }) {}

  async finalize(
    request: FinalizeRunRequest,
  ): Promise<FinalizeRunResponse> {
    const input = this.normalize(request);
    const existing = readWorkstreamFinalization(this.options.database, input.runId);
    if (existing) {
      assertMatchingRetry(this.options.database, existing, input);
      const pending = beginRecoverableIdempotent<FinalizeRunResponse | { runId: string }>({
        database: this.options.database,
        requestId: input.requestId,
        operation: "finalize_run",
        payload: request,
        now: input.at,
        execute: () => ({ runId: input.runId }),
      });
      if (pending.completed && "run" in pending.result) return pending.result;
      if (existing.phase === "completed" && existing.commitHead) {
        return completeRecoverableIdempotent({
          database: this.options.database,
          requestId: input.requestId,
          result: response(this.options.database, existing, existing.commitHead),
          now: input.at,
        });
      }
      return await this.execute(existing, input.at);
    }

    let prepared: Awaited<ReturnType<WorkstreamFinalizationService["prepare"]>>;
    try {
      prepared = await this.prepare(input);
    } catch (error) {
      if (error instanceof ContextEngineServiceError && error.code === "RECOVERY_REQUIRED") {
        markRunRecoveryRequired(this.options.database, input.runId);
      }
      throw error;
    }
    const pending = beginRecoverableIdempotent<FinalizeRunResponse | { runId: string }>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "finalize_run",
      payload: request,
      now: input.at,
      execute: () => {
        if (input.assistantResponse) {
          appendStreamMessage(this.options.database, {
            streamId: prepared.run.streamId,
            runId: input.runId,
            role: "assistant",
            content: input.assistantResponse,
            at: input.at,
          });
        }
        const messageHash = "sha256:" + createHash("sha256")
          .update(input.assistantResponse)
          .digest("hex");
        const plan: WorkstreamContextCommitPlan = {
          ...prepared.plan,
          commitMessage: renderWorkstreamCommit({
            subject: "finalize " + input.boundRequestId.toLowerCase() + " run",
            workstreamId: input.workstreamId,
            requestId: input.boundRequestId,
            runId: input.runId,
            streamId: prepared.run.streamId,
            outcome: commitOutcome(input.outcome),
            validation: input.validation,
            summary: prepared.finalSummary,
            ...(input.next ? { next: normalizeText(input.next) } : {}),
            messageHash,
          }),
        };
        insertWorkstreamFinalization(this.options.database, {
          runId: input.runId,
          operationRequestId: input.requestId,
          streamId: prepared.run.streamId,
          workstreamId: input.workstreamId,
          boundRequestId: input.boundRequestId,
          outcome: input.outcome,
          stopReason: input.stopReason,
          validation: input.validation,
          summary: prepared.finalSummary,
          ...(input.next ? { next: normalizeText(input.next) } : {}),
          completion: input.completion,
          assistantResponse: input.assistantResponse,
          baseHead: prepared.baseHead,
          messageHash,
          plan,
          resourceEvents: prepared.resourceEvents,
          at: input.at,
        });
        replaceRunWorkState(this.options.database, {
          runId: input.runId,
          afterStep: prepared.run.stepCount,
          state: input.workState,
          at: input.at,
        });
        return { runId: input.runId };
      },
    });
    if (pending.completed && "run" in pending.result) return pending.result;
    const record = readWorkstreamFinalization(this.options.database, input.runId);
    if (!record) throw new Error("Prepared workstream finalization could not be read.");
    await this.options.hook?.("plan_persisted", record);
    return await this.execute(record, input.at);
  }

  async recover(at: string): Promise<void> {
    for (const record of readRecoverableWorkstreamFinalizations(this.options.database)) {
      try {
        const result = await this.executeRecord(record, at);
        const completed = readWorkstreamFinalization(this.options.database, record.runId);
        if (!completed?.commitHead) throw new Error("Recovered workstream finalization is incomplete.");
        completeRecoverableIdempotent({
          database: this.options.database,
          requestId: record.operationRequestId,
          result: response(this.options.database, completed, result.head),
          now: at,
        });
      } catch (error) {
        this.markRecoveryRequired(record, error, at);
      }
    }
  }

  private normalize(input: FinalizeRunRequest): BoundFinalizeInput {
    const run = readRunEvidence(this.options.database, input.runId);
    const binding = run?.workstreamBinding;
    const completion = input.workstream?.completion;
    if (!run || !binding || !completion) {
      throw invalid("Workstream-bound finalization requires run binding and completion evidence.");
    }
    if (input.outcome === "done" && !completion.accepted) {
      throw invalid("A done workstream-bound run requires accepted completion evidence.");
    }
    return {
      ...input,
      workstreamId: binding.workstreamId,
      boundRequestId: binding.requestId,
      completion,
    };
  }

  private async prepare(input: BoundFinalizeInput) {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running"
      || run.workstreamBinding?.workstreamId !== input.workstreamId
      || run.workstreamBinding.requestId !== input.boundRequestId) {
      throw invalid("Finalization requires the matching active workstream-bound run.");
    }
    this.requireVerifiedMutationState(input.runId);
    const workstream = readWorkstreamInitialization(this.options.database, input.workstreamId);
    if (!workstream?.head || workstream.status !== "active") {
      throw invalid("Finalization requires an active workstream context repository.");
    }
    const validation = await validateWorkstreamRepository({
      workstreamRoot: this.options.workstreamRoot,
      contextRepositoryPath: workstream.contextRepositoryPath,
      expectedWorkstreamId: input.workstreamId,
      requestReadMode: "all",
    });
    if (validation.head !== workstream.head || validation.branch !== workstream.branch) {
      throw headMismatch(input.workstreamId, workstream.head, validation.head);
    }
    if (validation.health !== "ready") {
      throw recovery("Workstream context repository has unjournaled changes.", {
        workingTreeChanges: validation.workingTreeChanges,
      });
    }
    const routePlan = readWorkstreamRequestRoutePlan(this.options.database, input.runId);
    if (routePlan?.phase !== undefined && routePlan.phase !== "planned") {
      throw recovery("Workstream request route plan is not active.", { phase: routePlan.phase });
    }
    const planned = routePlan
      ? resolvePlannedWorkstreamRequestState(routePlan, validation)
      : validation.currentRequest
        ? {
            workstreamCard: validation.workstreamCard,
            workstreamRequest: validation.currentRequest,
            requestCreated: false,
          }
        : undefined;
    if (!planned || planned.workstreamRequest.id !== input.boundRequestId) {
      throw recovery("Finalization request no longer matches the run binding.");
    }

    const bindings = await this.options.resourceCatalog.admitCompletionResources({
      runId: input.runId,
      workstreamId: input.workstreamId,
      completion: input.completion,
      at: input.at,
    });
    const resourceEvents = readResourceEventsForRun(this.options.database, input.runId);
    const hasVerifiedChanges = resourceEvents.some((event) =>
      event.type === "created" || event.type === "modified" || event.type === "moved"
      || event.type === "deleted" || event.type === "downloaded"
      || event.type === "external_state_changed");
    const currentWorkState = readRunWorkState(this.options.database, input.runId);
    if (!currentWorkState) throw recovery("Finalization requires persisted WorkState.");
    const finalWorkState: RunWorkState = {
      ...input.workState,
      runId: input.runId,
      revision: currentWorkState.revision + 1,
      afterStep: run.stepCount,
      updatedAt: input.at,
    };
    const reduced = reduceSimpleWorkstreamContext({
      workstreamCard: planned.workstreamCard,
      workstreamRequest: planned.workstreamRequest,
      workState: finalWorkState,
      outcome: input.outcome,
      validation: input.validation,
      summary: input.summary,
      ...(input.next ? { next: input.next } : {}),
      completion: input.completion,
      hasVerifiedChanges,
    });
    const applyRoutePlan = Boolean(routePlan?.changePlan)
      && !(input.outcome === "failed" && !hasVerifiedChanges);
    const desiredWrites = new Map<string, string>();
    if (applyRoutePlan) {
      for (const write of routePlan!.changePlan!.writes) desiredWrites.set(write.path, write.content);
    }
    for (const write of reduced.contextWrites) desiredWrites.set(write.path, write.content);
    desiredWrites.set(WORKSTREAM_RESOURCES_PATH, renderResourceManifest(
      input.workstreamId,
      validation.resourceManifest.updatedAt,
      bindings,
    ));
    const contextWrites = await changedWrites(
      workstream.contextRepositoryPath,
      desiredWrites,
    );
    const contextBefore = await Promise.all(contextWrites.map(async (write) => ({
      path: write.path,
      sha256: await readContextHash(workstream.contextRepositoryPath, write.path),
    })));
    return {
      run,
      baseHead: workstream.head,
      resourceEvents,
      plan: {
        commitRequired: contextWrites.length > 0,
        contextWrites,
        contextBefore,
        stagedPaths: contextWrites.map((write) => write.path).sort(),
        commitMessage: "",
      },
      finalSummary: reduced.contextWrites.length > 0
        ? reduced.workstreamCard.currentSnapshot
        : normalizeText(input.summary),
    };
  }

  private requireVerifiedMutationState(runId: string): void {
    const blocking = this.options.database.prepare([
      "SELECT o.operation_id, o.status, l.status AS lease_status",
      "FROM resource_mutation_operations o JOIN resource_mutation_leases l ON l.lease_id = o.lease_id",
      "WHERE o.run_id = ? AND (o.status IN ('prepared', 'recovery_required')",
      "OR l.status IN ('active', 'recovery_required')) LIMIT 1",
    ].join(" ")).get(runId) as {
      operation_id: string;
      status: string;
      lease_status: string;
    } | undefined;
    if (blocking) {
      throw recovery("Run has an unverified or recovery-required resource mutation.", {
        operationId: blocking.operation_id,
        operationStatus: blocking.status,
        leaseStatus: blocking.lease_status,
      });
    }
  }

  private async execute(record: WorkstreamFinalizationRecord, at: string): Promise<FinalizeRunResponse> {
    try {
      const result = await this.executeRecord(record, at);
      const completed = readWorkstreamFinalization(this.options.database, record.runId);
      if (!completed) throw new Error("Completed workstream finalization could not be read.");
      const responseValue = response(this.options.database, completed, result.head);
      return completeRecoverableIdempotent({
        database: this.options.database,
        requestId: record.operationRequestId,
        result: responseValue,
        now: at,
      });
    } catch (error) {
      this.markRecoveryRequired(record, error, at);
      markRecoverableIdempotencyFailed({
        database: this.options.database,
        requestId: record.operationRequestId,
      });
      throw error;
    }
  }

  private async executeRecord(
    initial: WorkstreamFinalizationRecord,
    at: string,
  ): Promise<{ head: string; created: boolean }> {
    let record = readWorkstreamFinalization(this.options.database, initial.runId) ?? initial;
    if (record.phase === "recovery_required") {
      const workstream = readWorkstreamInitialization(this.options.database, record.workstreamId);
      if (!workstream) throw recovery("Recovery workstream is unavailable.");
      const recognizedHead = await recognizeCommittedWorkstreamContextPlan({
        contextRepositoryPath: workstream.contextRepositoryPath,
        branch: workstream.branch,
        baseHead: record.baseHead,
        plan: record.plan,
      });
      if (recognizedHead) {
        record = updateWorkstreamFinalization(this.options.database, {
          runId: record.runId,
          phase: "context_committed",
          commitHead: recognizedHead,
          commitCreated: true,
          at,
        });
      } else if (record.commitHead && record.commitHead !== record.baseHead) {
        throw recovery("Journaled workstream commit is no longer the repository HEAD.", {
          runId: record.runId,
          commitHead: record.commitHead,
        });
      } else {
        record = updateWorkstreamFinalization(this.options.database, {
          runId: record.runId,
          phase: "resource_effects_recorded",
          at,
        });
      }
    }
    if (record.phase === "prepared") {
      record = updateWorkstreamFinalization(this.options.database, {
        runId: record.runId,
        phase: "resource_effects_recorded",
        at,
      });
    }
    const workstream = readWorkstreamInitialization(this.options.database, record.workstreamId);
    if (!workstream?.head) throw recovery("Finalization workstream is unavailable.");
    let commit = {
      head: record.commitHead ?? record.baseHead,
      created: record.commitCreated,
    };
    if (record.phase === "resource_effects_recorded") {
      commit = await commitWorkstreamContextPlan({
        contextRepositoryPath: workstream.contextRepositoryPath,
        branch: workstream.branch,
        baseHead: record.baseHead,
        plan: record.plan,
        at,
      });
      record = updateWorkstreamFinalization(this.options.database, {
        runId: record.runId,
        phase: "context_committed",
        commitHead: commit.head,
        commitCreated: commit.created,
        at,
      });
      if (commit.created) await this.options.hook?.("commit_created", record);
    }
    if (!record.commitHead) throw recovery("Finalization journal is missing its context HEAD.");
    commit = { head: record.commitHead, created: record.commitCreated };
    const validation = await this.validateCommitted(record, commit.head);
    this.acknowledge(record, commit, validation, at);
    return commit;
  }

  private async validateCommitted(
    record: WorkstreamFinalizationRecord,
    head: string,
  ): Promise<WorkstreamRepositoryValidation> {
    const workstream = readWorkstreamInitialization(this.options.database, record.workstreamId);
    if (!workstream) throw recovery("Committed workstream is missing from the catalog.");
    const validation = await validateWorkstreamRepository({
      workstreamRoot: this.options.workstreamRoot,
      contextRepositoryPath: workstream.contextRepositoryPath,
      expectedWorkstreamId: record.workstreamId,
      requestReadMode: "all",
    });
    if (validation.head !== head || validation.health !== "ready") {
      throw recovery("Committed workstream context did not validate cleanly.");
    }
    const request = validation.requests.find((entry) => entry.id === record.boundRequestId);
    const routePlan = readWorkstreamRequestRoutePlan(this.options.database, record.runId);
    const discardedPlannedRequest = record.outcome === "failed"
      && !record.plan.commitRequired
      && routePlan?.changePlan?.primaryRequestId === record.boundRequestId;
    if (!request && !discardedPlannedRequest) {
      throw recovery("Committed workstream request is missing.");
    }
    if (!request) return validation;
    if (record.outcome === "done" && request.status !== "done") {
      throw recovery("Completed run did not persist a completed request.");
    }
    if ((record.outcome === "blocked" || record.outcome === "needs_user_input")
      && request.status !== "blocked") {
      throw recovery("Blocked run did not persist a blocked request.");
    }
    return validation;
  }

  private acknowledge(
    record: WorkstreamFinalizationRecord,
    commit: { head: string; created: boolean },
    validation: WorkstreamRepositoryValidation,
    at: string,
  ): void {
    this.options.database.transaction(() => {
      if (commit.created) {
        const workstream = readWorkstreamInitialization(this.options.database, record.workstreamId);
        if (workstream?.head === record.baseHead) {
          updateWorkstreamHead(this.options.database, record.workstreamId, record.baseHead, commit.head, at);
        } else if (workstream?.head !== commit.head) {
          throw new Error("Workstream catalog HEAD cannot acknowledge the context commit.");
        }
      }
      const current = validation.currentRequest;
      writeWorkstreamDiscoveryProjection(this.options.database, {
        workstreamId: record.workstreamId,
        expectedHead: commit.head,
        title: validation.workstreamCard.title,
        objective: validation.workstreamCard.purpose,
        lifecycleStatus: validation.workstreamCard.status,
        repositoryHealth: validation.health,
        ...(current ? {
          currentRequest: {
            id: current.id,
            title: current.title,
            status: current.status,
            searchText: [current.title, current.request].join("\n"),
          },
        } : {}),
      });
      const run = readRunEvidence(this.options.database, record.runId);
      if (run?.status === "running" || run?.status === "recovery_required") {
        finalizeRunRecord(this.options.database, {
          runId: record.runId,
          outcome: record.outcome,
          stopReason: record.stopReason,
          at,
        });
      }
      const routePlan = readWorkstreamRequestRoutePlan(this.options.database, record.runId);
      if (routePlan) {
        updateWorkstreamRequestRoutePlan(this.options.database, {
          runId: record.runId,
          phase: record.plan.commitRequired ? "committed" : "discarded",
          commitHead: commit.head,
          at,
        });
      }
      updateWorkstreamFinalization(this.options.database, {
        runId: record.runId,
        phase: "completed",
        commitHead: commit.head,
        commitCreated: commit.created,
        at,
      });
    });
  }

  private markRecoveryRequired(
    record: WorkstreamFinalizationRecord,
    error: unknown,
    at: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.database.transaction(() => {
      markRunRecoveryRequired(this.options.database, record.runId);
      updateWorkstreamFinalization(this.options.database, {
        runId: record.runId,
        phase: "recovery_required",
        error: message,
        at,
      });
      const routePlan = readWorkstreamRequestRoutePlan(this.options.database, record.runId);
      if (routePlan) {
        updateWorkstreamRequestRoutePlan(this.options.database, {
          runId: record.runId,
          phase: "recovery_required",
          error: message,
          at,
        });
      }
    });
  }
}

function renderResourceManifest(
  workstreamId: string,
  existingUpdatedAt: string,
  bindings: WorkstreamResourceBinding[],
): string {
  const updatedAt = bindings.reduce(
    (latest, binding) => binding.lastUsedAt && binding.lastUsedAt > latest ? binding.lastUsedAt : latest,
    existingUpdatedAt,
  );
  return renderWorkstreamResourceManifest({
    schema: WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
    workstreamId,
    updatedAt,
    resources: bindings.map((binding) => ({
      resourceId: binding.resource.resourceId,
      kind: binding.resource.kind,
      origin: binding.resource.origin,
      role: binding.role,
      access: binding.access,
      primary: binding.primary,
      requestIds: binding.requestIds,
      displayName: binding.resource.displayName,
      description: binding.resource.description,
      aliases: binding.resource.aliases,
      locator: binding.resource.locator,
      version: binding.resource.version,
      availability: binding.resource.availability,
      ...(binding.resource.mediaType ? { mediaType: binding.resource.mediaType } : {}),
      ...(binding.lastUsedAt ? { lastUsedAt: binding.lastUsedAt } : {}),
    })),
  });
}

async function changedWrites(
  contextRepositoryPath: string,
  desired: ReadonlyMap<string, string>,
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const [path, content] of desired) {
    const current = await readFile(join(contextRepositoryPath, path), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (current !== content) result.push({ path, content });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function readContextHash(contextRepositoryPath: string, path: string): Promise<string> {
  try {
    return contentHash(await readFile(join(contextRepositoryPath, path), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function response(
  database: ContextDatabase,
  record: WorkstreamFinalizationRecord,
  head: string,
): FinalizeRunResponse {
  const run = readRunEvidence(database, record.runId);
  const assistantMessage = readRunMessages(database, record.runId)
    .find((message) => message.role === "assistant");
  if (!run || (record.assistantResponse && !assistantMessage)) {
    throw new Error("Finalized workstream-bound run response cannot be reconstructed.");
  }
  const identity = {
    workstreamId: record.workstreamId,
    requestId: record.boundRequestId,
    headBefore: record.baseHead,
    headAfter: head,
  };
  return {
    run,
    ...(assistantMessage ? { assistantMessage } : {}),
    observationRevision: readReusableObservationProjection(database, record.streamId).revision,
    resourceEffects: {
      status: record.resourceEvents.length > 0 ? "verified" : "none",
      events: record.resourceEvents.map((event) => ({
        eventId: event.eventId,
        resourceId: event.resourceId,
        type: event.type,
        ...(event.afterVersion ? { afterVersionKey: event.afterVersion.key } : {}),
      })),
    },
    workstreamContextCommit: !record.plan.commitRequired
      ? { status: "not_required" }
      : record.commitCreated
        ? { status: "committed", ...identity, commit: head }
        : { status: "no_change", ...identity },
  };
}

function assertMatchingRetry(
  database: ContextDatabase,
  record: WorkstreamFinalizationRecord,
  input: BoundFinalizeInput,
): void {
  const run = readRunEvidence(database, input.runId);
  const matches = record.operationRequestId === input.requestId
    && record.streamId === run?.streamId
    && record.workstreamId === input.workstreamId
    && record.boundRequestId === input.boundRequestId
    && record.runId === input.runId
    && record.outcome === input.outcome
    && record.stopReason === input.stopReason
    && record.validation === input.validation
    && (record.next ?? null) === (input.next ? normalizeText(input.next) : null)
    && record.assistantResponse === input.assistantResponse
    && JSON.stringify(record.completion) === JSON.stringify(input.completion);
  if (!matches) {
    throw new ContextEngineServiceError({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Finalization retry does not match its persisted run journal.",
      details: { runId: input.runId },
    });
  }
}

function commitOutcome(outcome: RunOutcome): WorkstreamCommitOutcome {
  if (outcome === "done") return "completed";
  if (outcome === "needs_user_input") return "blocked";
  return outcome;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function invalid(message: string, details?: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({ code: "INVALID_REQUEST", message, ...(details ? { details } : {}) });
}

function recovery(message: string, details?: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({ code: "RECOVERY_REQUIRED", message, ...(details ? { details } : {}) });
}

function headMismatch(workstreamId: string, expected: string, actual: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_HEAD_MISMATCH",
    message: "Workstream context HEAD changed during finalization.",
    details: { workstreamId, expectedHead: expected, actualHead: actual },
  });
}
