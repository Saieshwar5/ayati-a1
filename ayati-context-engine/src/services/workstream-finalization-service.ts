import { createHash } from "node:crypto";
import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  RunOutcome,
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
  recognizeCommittedWorkstreamContextPlan,
} from "../git/workstream-context-transaction.js";
import { appendStreamMessage, readRunMessages } from "../repositories/message-records.js";
import {
  markRunRecoveryRequired,
  readActiveRunIds,
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
import { resolveAssistantResponseMetadata } from "./assistant-response-metadata.js";
import {
  readWorkstreamInitialization,
} from "../repositories/workstream-records.js";
import {
  markSharedWorkstreamRepositoryHealth,
} from "../repositories/workstream-repository-state-records.js";
import {
  readWorkstreamRequestRoutePlan,
  updateWorkstreamRequestRoutePlan,
} from "../repositories/workstream-request-route-plan-records.js";
import {
  renderWorkstreamCommit,
  type WorkstreamCommitOutcome,
} from "../workstreams/workstream-commit-metadata.js";
import type { ResourceCatalogService } from "./resource-catalog-service.js";
import {
  acknowledgeWorkstreamFinalization,
  validateCommittedWorkstreamFinalization,
} from "./workstream-finalization-acknowledger.js";
import {
  prepareWorkstreamFinalization,
  type BoundWorkstreamFinalizeInput,
} from "./workstream-finalization-planner.js";

export type WorkstreamFinalizationHook = (
  phase: "plan_persisted" | "commit_created",
  record: WorkstreamFinalizationRecord,
) => void | Promise<void>;

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

    let prepared: Awaited<ReturnType<typeof prepareWorkstreamFinalization>>;
    try {
      prepared = await prepareWorkstreamFinalization({
        database: this.options.database,
        workstreamRoot: this.options.workstreamRoot,
        resourceCatalog: this.options.resourceCatalog,
        request: input,
      });
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
          const responseMetadata = resolveAssistantResponseMetadata(input);
          appendStreamMessage(this.options.database, {
            streamId: prepared.run.streamId,
            runId: input.runId,
            role: "assistant",
            content: input.assistantResponse,
            ...responseMetadata,
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
            mutations: mutationCount(prepared.resourceEvents),
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
          requestEffect: input.requestEffect,
          assistantResponse: input.assistantResponse,
          baseHead: prepared.baseHead,
          workstreamBaseHead: prepared.workstreamBaseHead,
          messageHash,
          plan,
          resourceEvents: prepared.resourceEvents,
          at: input.at,
        });
        replaceRunWorkState(this.options.database, {
          runId: input.runId,
          afterStep: prepared.run.stepCount,
          state: input.workState,
          reason: input.outcome === "done" ? "run_completed" : "run_paused",
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
    await this.recoverInterruptedBoundRuns(at);
  }

  private async recoverInterruptedBoundRuns(at: string): Promise<void> {
    for (const runId of readActiveRunIds(this.options.database)) {
      const run = readRunEvidence(this.options.database, runId);
      if (!run?.workstreamBinding || run.status !== "running") continue;
      if (readWorkstreamFinalization(this.options.database, runId)) continue;
      const routePlan = readWorkstreamRequestRoutePlan(this.options.database, runId);
      if (!routePlan || routePlan.phase !== "planned") continue;
      const workState = readRunWorkState(this.options.database, runId);
      if (!workState) {
        markRunRecoveryRequired(this.options.database, runId);
        continue;
      }
      try {
        await this.finalize({
          requestId: "RECOVER:" + runId + ":finalize",
          runId,
          outcome: "incomplete",
          stopReason: "interrupted",
          assistantResponse: "",
          streamSummary: "The previous run was interrupted before durable finalization.",
          summary: "The run was interrupted; its verified context and request routing were recovered.",
          validation: "not_applicable",
          ...(workState.nextAction ? { next: workState.nextAction } : {}),
          workState: {
            status: workState.status,
            summary: workState.summary,
            plan: workState.plan,
            importantContext: workState.importantContext,
            nextAction: workState.nextAction ?? null,
          },
          workstream: {
            completion: {
              accepted: false,
              resources: [],
              missing: ["The interrupted run did not submit final acceptance evidence."],
              failures: [],
              criteria: [],
            },
            requestEffect: { kind: "none" },
          },
          at,
        });
      } catch (error) {
        const record = readWorkstreamFinalization(this.options.database, runId);
        if (record) {
          this.markRecoveryRequired(record, error, at);
        } else {
          markRunRecoveryRequired(this.options.database, runId);
        }
      }
    }
  }

  private normalize(input: FinalizeRunRequest): BoundWorkstreamFinalizeInput {
    const run = readRunEvidence(this.options.database, input.runId);
    const binding = run?.workstreamBinding;
    const completion = input.workstream?.completion;
    const requestEffect = input.workstream?.requestEffect;
    if (!run || !binding || !completion || !requestEffect) {
      throw invalid("Workstream-bound finalization requires run binding and completion evidence.");
    }
    if (requestEffect.kind === "complete" && !completion.accepted) {
      throw invalid("Completing a request requires accepted completion evidence.");
    }
    return {
      ...input,
      workstreamId: binding.workstreamId,
      boundRequestId: binding.requestId,
      completion,
      requestEffect,
    };
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
    const validation = await validateCommittedWorkstreamFinalization({
      database: this.options.database,
      workstreamRoot: this.options.workstreamRoot,
      record,
      head: commit.head,
    });
    acknowledgeWorkstreamFinalization({
      database: this.options.database,
      record,
      commit,
      validation,
      at,
    });
    return commit;
  }

  private markRecoveryRequired(
    record: WorkstreamFinalizationRecord,
    error: unknown,
    at: string,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.database.transaction(() => {
      markRunRecoveryRequired(this.options.database, record.runId);
      markSharedWorkstreamRepositoryHealth(
        this.options.database,
        "recovery_required",
        at,
      );
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
  input: BoundWorkstreamFinalizeInput,
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
    && JSON.stringify(record.completion) === JSON.stringify(input.completion)
    && JSON.stringify(record.requestEffect) === JSON.stringify(input.requestEffect);
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

function mutationCount(events: Array<{ type: string }>): number {
  const mutations = new Set([
    "created",
    "modified",
    "moved",
    "deleted",
    "restored",
    "downloaded",
    "external_state_changed",
  ]);
  return events.filter((event) => mutations.has(event.type)).length;
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
