import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  closeRunConversationWithAssistant,
  closeRunConversationWithoutAssistant,
  readConversation,
} from "../repositories/conversation-records.js";
import { readConversationPersistenceState } from "../repositories/conversation-persistence-records.js";
import {
  finalizeRunRecord,
  markRunRecoveryRequired,
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import {
  readRunWorkState,
  replaceRunWorkState,
} from "../repositories/run-work-state-records.js";
import {
  insertUnboundRunFinalization,
  readRecoverableUnboundRunFinalizations,
  readUnboundRunFinalization,
  updateUnboundRunFinalization,
  type UnboundRunFinalizationRecord,
} from "../repositories/unbound-run-finalization-records.js";
import { readSessionRecord } from "../repositories/session-records.js";
import { unboundRunPaths, writeUnboundRunFiles } from "../runs/unbound-run-files.js";
import {
  renderFinalizedUnboundRun,
  renderUnboundRunSteps,
} from "../runs/unbound-run-renderer.js";

export class UnboundRunFinalizationService {
  constructor(private readonly database: ContextDatabase) {}

  async finalize(
    input: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const existing = readUnboundRunFinalization(this.database, input.runId);
    if (existing && existing.requestId !== input.requestId) {
      throw new GitContextServiceError({
        code: "IDEMPOTENCY_CONFLICT",
        message: "Run finalization must reuse its stable request identity.",
        details: { runId: input.runId },
      });
    }
    const run = readRunEvidence(this.database, input.runId);
    if (!run
      || run.sessionId !== input.sessionId
      || run.workstreamBinding
      || (!existing && run.status !== "running")) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Unbound finalization requires the matching active unbound run.",
        details: { sessionId: input.sessionId, runId: input.runId },
      });
    }
    const paths = unboundRunPaths(session.repositoryPath, run.runId);
    type Pending = { runId: string } | FinalizeRunResponse;
    const pending = beginRecoverableIdempotent<Pending>({
      database: this.database,
      requestId: input.requestId,
      operation: "finalize_run",
      payload: input,
      now: input.at,
      execute: () => {
        if (!existing) {
          insertUnboundRunFinalization(this.database, {
            runId: run.runId,
            requestId: input.requestId,
            sessionId: input.sessionId,
            conversationId: run.conversationId,
            outcome: input.outcome,
            stopReason: input.stopReason,
            materializationRequested: run.stepCount > 0,
            ...(run.stepCount > 0
              ? { runFile: paths.runRelative, stepsFile: paths.stepsRelative }
              : {}),
            at: input.at,
          });
          replaceRunWorkState(this.database, {
            runId: run.runId,
            afterStep: run.stepCount,
            state: input.workState,
            at: input.at,
          });
          closeConversation(this.database, {
            sessionId: input.sessionId,
            conversationId: run.conversationId,
            runId: run.runId,
            assistantResponse: input.assistantResponse,
            at: input.at,
          });
        }
        return { runId: run.runId };
      },
    });
    if (pending.completed && "run" in pending.result) return pending.result;
    const record = readUnboundRunFinalization(this.database, run.runId);
    if (!record) throw new Error("Prepared unbound finalization could not be read.");
    if (record.phase === "completed") {
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: response(this.database, record),
        now: input.at,
      });
    }

    try {
      await this.complete(record, session, input.at);
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
      const row = readSessionRecord(this.database, record.sessionId);
      if (!row) continue;
      const session: SessionRef = {
        sessionId: row.sessionId,
        repositoryPath: row.repositoryPath,
        head: row.head,
        date: row.date,
        timezone: row.timezone,
        status: row.status,
      };
      try {
        await this.complete(record, session, at);
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

  private async complete(
    record: UnboundRunFinalizationRecord,
    session: SessionRef,
    at: string,
  ): Promise<void> {
    const run = readRunEvidence(this.database, record.runId);
    const workState = readRunWorkState(this.database, record.runId);
    if (!run || !workState) throw new Error("Unbound finalization evidence is incomplete.");
    if (record.materializationRequested) {
      if (!record.runFile || !record.stepsFile) {
        throw new Error("Unbound materialization paths are missing.");
      }
      const paths = unboundRunPaths(session.repositoryPath, record.runId);
      const finalizedRun = {
        ...run,
        status: record.outcome,
        stopReason: record.stopReason,
        completedAt: at,
      };
      await writeUnboundRunFiles({
        sessionRepository: session.repositoryPath,
        runFile: paths.runFile,
        stepsFile: paths.stepsFile,
        runContent: renderFinalizedUnboundRun({ run: finalizedRun, workState }),
        stepsContent: renderUnboundRunSteps(readRunStepEvidence(this.database, record.runId)),
      });
      updateUnboundRunFinalization(this.database, {
        runId: record.runId,
        phase: "files_written",
        at,
      });
    }
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

function closeConversation(database: ContextDatabase, input: {
  sessionId: string;
  conversationId: string;
  runId: string;
  assistantResponse: string;
  at: string;
}): void {
  if (input.assistantResponse) {
    closeRunConversationWithAssistant(database, {
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      runId: input.runId,
      content: input.assistantResponse,
      at: input.at,
    });
    return;
  }
  closeRunConversationWithoutAssistant(database, input);
}

function response(
  database: ContextDatabase,
  record: UnboundRunFinalizationRecord,
): FinalizeRunResponse {
  const run = readRunEvidence(database, record.runId);
  const conversation = readConversation(database, record.conversationId);
  const persistence = readConversationPersistenceState(database, record.conversationId);
  if (!run || !conversation || !persistence) {
    throw new Error("Finalized unbound run response cannot be reconstructed.");
  }
  return {
    run,
    conversation,
    persistence,
    materialization: record.materializationRequested
      ? {
          status: "materialized",
          ...(record.runFile ? { runFile: record.runFile } : {}),
          ...(record.stepsFile ? { stepsFile: record.stepsFile } : {}),
        }
      : { status: "not_requested" },
    resourceEffects: { status: "none", events: [] },
    workstreamContextCommit: { status: "not_required" },
  };
}
