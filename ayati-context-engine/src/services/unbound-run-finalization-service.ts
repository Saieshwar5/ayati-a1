import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  appendStreamMessage,
  readStreamMessage,
} from "../repositories/message-records.js";
import { readReusableObservationProjection } from "../repositories/reusable-observation-records.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
  readRunEvidence,
} from "../repositories/run-records.js";
import { replaceRunWorkState } from "../repositories/run-work-state-records.js";
import {
  insertUnboundRunFinalization,
  readRecoverableUnboundRunFinalizations,
  readUnboundRunFinalization,
  updateUnboundRunFinalization,
  type UnboundRunFinalizationRecord,
} from "../repositories/unbound-run-finalization-records.js";

export class UnboundRunFinalizationService {
  constructor(private readonly database: ContextDatabase) {}

  async finalize(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    const existing = readUnboundRunFinalization(this.database, input.runId);
    if (existing && existing.requestId !== input.requestId) {
      throw new ContextEngineServiceError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Run finalization must reuse its stable request identity.",
        details: { runId: input.runId },
      });
    }
    const run = readRunEvidence(this.database, input.runId);
    if (!run || run.workstreamBinding || (!existing && run.status !== "running")) {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Unbound finalization requires the matching active unbound run.",
        details: { runId: input.runId },
      });
    }
    type Pending = { runId: string } | FinalizeRunResponse;
    const pending = beginRecoverableIdempotent<Pending>({
      database: this.database,
      requestId: input.requestId,
      operation: "finalize_run",
      payload: input,
      now: input.at,
      execute: () => {
        if (!existing) {
          const assistantMessage = input.assistantResponse
            ? appendStreamMessage(this.database, {
                streamId: run.streamId,
                runId: run.runId,
                role: "assistant",
                content: input.assistantResponse,
                at: input.at,
              })
            : undefined;
          replaceRunWorkState(this.database, {
            runId: run.runId,
            afterStep: run.stepCount,
            state: input.workState,
            at: input.at,
          });
          insertUnboundRunFinalization(this.database, {
            runId: run.runId,
            requestId: input.requestId,
            streamId: run.streamId,
            outcome: input.outcome,
            stopReason: input.stopReason,
            ...(assistantMessage ? { assistantMessageId: assistantMessage.messageId } : {}),
            at: input.at,
          });
        }
        return { runId: run.runId };
      },
    });
    if (pending.completed && "run" in pending.result) return pending.result;
    const record = readUnboundRunFinalization(this.database, run.runId);
    if (!record) throw new Error("Prepared unbound finalization could not be read.");
    try {
      this.complete(record, input.at);
      const completed = readUnboundRunFinalization(this.database, input.runId);
      if (!completed) throw new Error("Completed unbound finalization is missing.");
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: response(this.database, completed),
        now: input.at,
      });
    } catch (error) {
      this.database.transaction(() => {
        markRunRecoveryRequired(this.database, input.runId);
        updateUnboundRunFinalization(this.database, {
          runId: input.runId,
          phase: "recovery_required",
          at: input.at,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw error;
    }
  }

  async recover(at: string): Promise<void> {
    for (const record of readRecoverableUnboundRunFinalizations(this.database)) {
      try {
        this.complete(record, at);
        const completed = readUnboundRunFinalization(this.database, record.runId);
        if (!completed) throw new Error("Recovered unbound finalization is missing.");
        completeRecoverableIdempotent({
          database: this.database,
          requestId: record.requestId,
          result: response(this.database, completed),
          now: at,
        });
      } catch (error) {
        markRunRecoveryRequired(this.database, record.runId);
        updateUnboundRunFinalization(this.database, {
          runId: record.runId,
          phase: "recovery_required",
          at,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private complete(record: UnboundRunFinalizationRecord, at: string): void {
    this.database.transaction(() => {
      const current = readRunEvidence(this.database, record.runId);
      if (current?.status === "running" || current?.status === "recovery_required") {
        finalizeRunRecord(this.database, {
          runId: record.runId,
          outcome: record.outcome,
          stopReason: record.stopReason,
          at,
        });
      }
      updateUnboundRunFinalization(this.database, {
        runId: record.runId,
        phase: "completed",
        at,
      });
    });
  }
}

function response(
  database: ContextDatabase,
  record: UnboundRunFinalizationRecord,
): FinalizeRunResponse {
  const run = readRunEvidence(database, record.runId);
  const assistantMessage = record.assistantMessageId
    ? readStreamMessage(database, record.assistantMessageId)
    : undefined;
  if (!run || (record.assistantMessageId && !assistantMessage)) {
    throw new Error("Finalized unbound run response cannot be reconstructed.");
  }
  return {
    run,
    ...(assistantMessage ? { assistantMessage } : {}),
    observationRevision: readReusableObservationProjection(database, record.streamId).revision,
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: { status: "not_required" },
  };
}
