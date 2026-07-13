import type {
  FinalizeSessionRunRequest,
  FinalizeSessionRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { closeSessionConversationWithAssistant } from "../repositories/conversation-records.js";
import {
  readSessionRunFinalization,
  insertSessionRunFinalization,
  updateSessionRunFinalization,
} from "../repositories/session-run-finalization-records.js";
import {
  completeSessionRun,
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";
import {
  readRunWorkState,
  replaceRunWorkState,
} from "../repositories/run-work-state-records.js";
import { sessionRunPaths, writeSessionRunFiles } from "../runs/session-run-files.js";
import {
  renderCompletedSessionRun,
  renderCompleteSessionRunSteps,
} from "../runs/session-run-renderer.js";

export class SessionRunFinalizationService {
  constructor(private readonly database: ContextDatabase) {}

  async finalize(
    input: FinalizeSessionRunRequest,
    session: SessionRef,
  ): Promise<FinalizeSessionRunResponse> {
    const existing = readSessionRunFinalization(this.database, input.runId);
    const run = readRunEvidence(this.database, input.runId);
    if (!run
      || run.sessionId !== input.sessionId
      || run.runClass !== "session"
      || (!existing && run.status !== "running")) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Session-run finalization requires the matching active session run.",
        details: { sessionId: input.sessionId, runId: input.runId },
      });
    }
    if (!existing && run.stepCount === 0) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "A session run cannot finish without a recorded read-only tool step.",
        details: { runId: input.runId },
      });
    }
    const paths = sessionRunPaths(session.repositoryPath, run.runId);
    type Pending = { runId: string } | FinalizeSessionRunResponse;
    const pending = beginRecoverableIdempotent<Pending>({
      database: this.database,
      requestId: input.requestId,
      operation: "finalize_session_run",
      payload: input,
      now: input.at,
      execute: () => {
        if (!existing) {
          insertSessionRunFinalization(this.database, {
            runId: run.runId,
            requestId: input.requestId,
            sessionId: input.sessionId,
            conversationId: run.conversationId,
            runFile: paths.runRelative,
            stepsFile: paths.stepsRelative,
            at: input.at,
          });
          replaceRunWorkState(this.database, {
            runId: run.runId,
            afterStep: run.stepCount,
            state: input.workState,
            at: input.at,
          });
          closeSessionConversationWithAssistant(this.database, {
            sessionId: input.sessionId,
            conversationId: run.conversationId,
            runId: run.runId,
            content: input.assistantResponse,
            at: input.at,
          });
        }
        return { runId: run.runId };
      },
    });
    if (pending.completed && "runFile" in pending.result) return pending.result;
    const prepared = readSessionRunFinalization(this.database, run.runId);
    if (prepared?.phase === "completed") {
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: responseFor(run.runId, prepared.runFile, prepared.stepsFile, run.stepCount),
        now: input.at,
      });
    }

    try {
      const workState = readRunWorkState(this.database, run.runId);
      if (!workState || workState.status !== "done") {
        throw new Error("Completed session run requires final done WorkState.");
      }
      const steps = readRunStepEvidence(this.database, run.runId);
      await writeSessionRunFiles({
        sessionRepository: session.repositoryPath,
        runFile: paths.runFile,
        stepsFile: paths.stepsFile,
        runContent: renderCompletedSessionRun({ run, workState, completedAt: input.at }),
        stepsContent: renderCompleteSessionRunSteps(steps),
      });
      updateSessionRunFinalization(this.database, run.runId, "files_written", input.at);
      this.database.transaction(() => {
        completeSessionRun(this.database, run.runId, input.at);
        updateSessionRunFinalization(this.database, run.runId, "completed", input.at);
      });
      const response = responseFor(
        run.runId,
        paths.runRelative,
        paths.stepsRelative,
        steps.length,
      );
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: response,
        now: input.at,
      });
    } catch (error) {
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw error;
    }
  }
}

function responseFor(
  runId: string,
  runFile: string,
  stepsFile: string,
  stepCount: number,
): FinalizeSessionRunResponse {
  return {
    runId,
    status: "completed",
    runFile,
    stepsFile,
    stepCount,
  };
}
