import type {
  SessionRef,
  SnapshotTaskRunEvidenceRequest,
  SnapshotTaskRunEvidenceResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  taskRunEvidencePaths,
  writeAndStageRunEvidence,
} from "../runs/run-evidence-files.js";
import {
  evidenceSourceRevision,
  renderRunEvidence,
  renderStepEvidence,
} from "../runs/run-evidence-renderer.js";
import {
  insertRunEvidenceSnapshot,
  readRunEvidenceSnapshot,
  readTaskHeadRange,
  readUncheckpointedMutationStatus,
  updateRunEvidenceSnapshotPhase,
} from "../repositories/run-evidence-records.js";
import {
  readRunEvidence,
  readRunStepEvidence,
} from "../repositories/run-records.js";

export class TaskRunEvidenceService {
  constructor(private readonly database: ContextDatabase) {}

  async snapshot(
    input: SnapshotTaskRunEvidenceRequest,
    session: SessionRef,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
    const run = readRunEvidence(this.database, input.runId);
    if (!run
      || run.sessionId !== input.sessionId
      || run.runClass !== "task"
      || run.taskId !== input.taskId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Task-run evidence requires the matching promoted task run.",
        details: { sessionId: input.sessionId, runId: input.runId, taskId: input.taskId },
      });
    }
    if (!session.head) {
      throw new GitContextServiceError({
        code: "REPOSITORY_UNAVAILABLE",
        message: "Session repository has no durable HEAD.",
        details: { sessionId: session.sessionId },
      });
    }
    const headRange = readTaskHeadRange(this.database, run.runId);
    if (!headRange) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task run has no mutation provenance for evidence persistence.",
        details: { runId: run.runId, taskId: input.taskId },
      });
    }
    const uncheckpointedStatus = readUncheckpointedMutationStatus(this.database, run.runId);
    if (uncheckpointedStatus) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task-run evidence cannot snapshot uncheckpointed mutation state.",
        details: { runId: run.runId, taskId: input.taskId, mutationStatus: uncheckpointedStatus },
      });
    }
    const steps = readRunStepEvidence(this.database, run.runId);
    const revision = evidenceSourceRevision({
      run,
      steps,
      taskHeadBefore: headRange.before,
      taskHeadAfter: headRange.after,
    });
    const paths = taskRunEvidencePaths(session.repositoryPath, run.runId);
    type PendingResult = { requestId: string } | SnapshotTaskRunEvidenceResponse;
    const pending = beginRecoverableIdempotent<PendingResult>({
      database: this.database,
      requestId: input.requestId,
      operation: "snapshot_task_run_evidence",
      payload: input,
      now: input.at,
      execute: () => {
        insertRunEvidenceSnapshot(this.database, {
          requestId: input.requestId,
          runId: run.runId,
          sessionId: run.sessionId,
          taskId: input.taskId,
          runFile: paths.runRelative,
          stepsFile: paths.stepsRelative,
          sourceRevision: revision,
          at: input.at,
        });
        return { requestId: input.requestId };
      },
    });
    if (pending.completed && "runFile" in pending.result) {
      return pending.result;
    }
    const snapshot = readRunEvidenceSnapshot(this.database, input.requestId);
    if (!snapshot || snapshot.sourceRevision !== revision) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task-run journal changed during evidence snapshot recovery.",
        details: { runId: run.runId, requestId: input.requestId },
      });
    }
    try {
      await writeAndStageRunEvidence({
        sessionRepository: session.repositoryPath,
        runFile: paths.runFile,
        stepsFile: paths.stepsFile,
        runContent: renderRunEvidence({
          run,
          taskHeadBefore: headRange.before,
          taskHeadAfter: headRange.after,
          stepCount: steps.length,
          snapshotAt: input.at,
        }),
        stepsContent: renderStepEvidence(steps),
        expectedSessionHead: session.head,
      });
      updateRunEvidenceSnapshotPhase(this.database, input.requestId, "files_written", input.at);
      updateRunEvidenceSnapshotPhase(this.database, input.requestId, "staged", input.at);
      const result: SnapshotTaskRunEvidenceResponse = {
        runId: run.runId,
        taskId: input.taskId,
        runFile: paths.runRelative,
        stepsFile: paths.stepsRelative,
        stepCount: steps.length,
        taskHeadBefore: headRange.before,
        taskHeadAfter: headRange.after,
        sessionHeadUnchanged: true,
        staged: true,
      };
      updateRunEvidenceSnapshotPhase(this.database, input.requestId, "completed", input.at);
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result,
        now: input.at,
      });
    } catch (error) {
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw error;
    }
  }
}
