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
import { resolveAssistantResponseMetadata } from "./assistant-response-metadata.js";

export class UnboundRunFinalizationService {
  constructor(private readonly database: ContextDatabase) {}

  async finalize(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    return await this.finalizeInternal(input);
  }

  async finalizeDiscardingProvisionalWorkstream(
    input: FinalizeRunRequest,
    discard: () => void,
  ): Promise<FinalizeRunResponse> {
    return await this.finalizeInternal(withoutWorkstreamCompletion(input), {
      allowInitiallyBoundRun: true,
      beforePrepare: discard,
    });
  }

  private async finalizeInternal(
    input: FinalizeRunRequest,
    options: {
      allowInitiallyBoundRun?: boolean;
      beforePrepare?: () => void;
    } = {},
  ): Promise<FinalizeRunResponse> {
    const existing = readUnboundRunFinalization(this.database, input.runId);
    if (existing && existing.requestId !== input.requestId) {
      throw new ContextEngineServiceError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Run finalization must reuse its stable request identity.",
        details: { runId: input.runId },
      });
    }
    const run = readRunEvidence(this.database, input.runId);
    const initiallyBoundForDiscard = Boolean(
      !existing && options.allowInitiallyBoundRun && options.beforePrepare && run?.workstreamBinding,
    );
    if (!run
      || (run.workstreamBinding && !initiallyBoundForDiscard)
      || (!existing && run.status !== "running")) {
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
          options.beforePrepare?.();
          const preparedRun = readRunEvidence(this.database, input.runId);
          if (!preparedRun || preparedRun.status !== "running" || preparedRun.workstreamBinding) {
            throw new ContextEngineServiceError({
              code: "RECOVERY_REQUIRED",
              message: "Unbound finalization preparation requires a detached active run.",
              details: { runId: input.runId },
            });
          }
          const responseMetadata = resolveAssistantResponseMetadata(input);
          const assistantMessage = input.assistantResponse
            ? appendStreamMessage(this.database, {
                streamId: preparedRun.streamId,
                runId: preparedRun.runId,
                role: "assistant",
                content: input.assistantResponse,
                ...responseMetadata,
                at: input.at,
              })
            : undefined;
          replaceRunWorkState(this.database, {
            runId: preparedRun.runId,
            afterStep: preparedRun.stepCount,
            state: input.workState,
            reason: input.outcome === "done" ? "run_completed" : "run_paused",
            at: input.at,
          });
          insertUnboundRunFinalization(this.database, {
            runId: preparedRun.runId,
            requestId: input.requestId,
            streamId: preparedRun.streamId,
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

export function withoutWorkstreamCompletion(
  input: FinalizeRunRequest,
): FinalizeRunRequest {
  const { workstream: _workstream, ...unbound } = input;
  return unbound;
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
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: { status: "not_required" },
  };
}
