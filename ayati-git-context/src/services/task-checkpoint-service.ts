import type {
  CheckpointMutationRequest,
  CheckpointMutationResponse,
  MutationProvenance,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  markRecoverableIdempotencyFailed,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  hasMutationChanges,
  readMutationProvenance,
} from "../git/mutation-provenance.js";
import { runGit } from "../git/git-process.js";
import {
  assertCheckpointablePaths,
  checkpointPaths,
  stageVerifiedTaskMutation,
} from "../git/task-checkpoint.js";
import {
  readMutationAuthority,
  releaseCheckpointedMutationAuthority,
} from "../repositories/mutation-authority-records.js";
import {
  insertTaskCheckpoint,
  readTaskCheckpoint,
  updateTaskCheckpointPhase,
  type TaskCheckpointRecord,
} from "../repositories/task-checkpoint-records.js";
import { readRun } from "../repositories/run-records.js";
import { verifyMutationLockToken } from "./mutation-boundary-service.js";

export class TaskCheckpointService {
  constructor(private readonly database: ContextDatabase) {}

  async checkpoint(input: CheckpointMutationRequest): Promise<CheckpointMutationResponse> {
    const authority = readMutationAuthority(this.database, input.authorityId);
    if (!authority) {
      throw new GitContextServiceError({
        code: "NOT_FOUND",
        message: "Mutation authority does not exist.",
        details: { authorityId: input.authorityId },
      });
    }
    verifyMutationLockToken(authority, input.lockToken);
    const existing = readTaskCheckpoint(this.database, input.authorityId);
    if (!existing && authority.status !== "verified") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Only a verified mutation can be checkpointed.",
        details: { authorityId: authority.authorityId, status: authority.status },
      });
    }
    const run = readRun(this.database, authority.runId);
    if (!run || run.conversationId !== input.conversationId) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Checkpoint conversation does not own the mutation run.",
        details: { authorityId: authority.authorityId, conversationId: input.conversationId },
      });
    }

    type PendingResult = { authorityId: string } | CheckpointMutationResponse;
    const pending = beginRecoverableIdempotent<PendingResult>({
      database: this.database,
      requestId: input.requestId,
      operation: "checkpoint_mutation",
      payload: input,
      now: input.at,
      execute: () => {
        if (!existing) {
          const provenance = verifiedProvenance(authority.verification);
          const stagedPaths = checkpointPaths(provenance);
          assertCheckpointablePaths(stagedPaths);
          insertTaskCheckpoint(this.database, {
            authorityId: authority.authorityId,
            requestId: input.requestId,
            sessionId: authority.sessionId,
            runId: authority.runId,
            taskId: authority.taskId,
            beforeHead: authority.beforeHead,
            purpose: normalizePurpose(input.purpose),
            conversationId: input.conversationId,
            conversationHash: input.conversationHash,
            stagedPaths,
            at: input.at,
          });
        }
        return { authorityId: authority.authorityId };
      },
    });
    if (pending.completed && "checkpointHead" in pending.result) {
      return pending.result;
    }

    try {
      const record = readTaskCheckpoint(this.database, authority.authorityId);
      if (!record) {
        throw new Error("Checkpoint operation has no SQLite transaction record.");
      }
      if (record.phase === "completed" && record.checkpointHead) {
        return completeRecoverableIdempotent({
          database: this.database,
          requestId: input.requestId,
          result: checkpointResponse(record),
          now: input.at,
        });
      }
      await this.requireUnchangedProvenance(authority, record);
      await stageVerifiedTaskMutation({
        checkoutPath: authority.checkoutPath,
        branch: authority.branch,
        beforeHead: authority.beforeHead,
        authorityId: authority.authorityId,
        stagedPaths: record.stagedPaths,
      });
      const result: CheckpointMutationResponse = {
        authorityId: authority.authorityId,
        taskId: authority.taskId,
        runId: authority.runId,
        beforeHead: authority.beforeHead,
        checkpointHead: authority.beforeHead,
        stagedPaths: record.stagedPaths,
        sessionGitlinkUpdated: false,
      };
      this.database.transaction(() => {
        updateTaskCheckpointPhase(this.database, {
          authorityId: authority.authorityId,
          phase: "completed",
          checkpointHead: authority.beforeHead,
          at: input.at,
        });
        releaseCheckpointedMutationAuthority(this.database, authority.authorityId, input.at);
      });
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

  private async requireUnchangedProvenance(
    authority: NonNullable<ReturnType<typeof readMutationAuthority>>,
    record: TaskCheckpointRecord,
  ): Promise<void> {
    if (record.phase !== "prepared") {
      return;
    }
    const head = await runGit(["rev-parse", "HEAD"], { cwd: authority.checkoutPath });
    if (head !== authority.beforeHead) {
      return;
    }
    const current = await readMutationProvenance(
      authority.checkoutPath,
      authority.targets,
      "index",
    );
    const verified = verifiedProvenance(authority.verification);
    if (JSON.stringify(current) !== JSON.stringify(verified)) {
      const stagedOutput = await runGit(["diff", "--cached", "--name-only", "--"], {
        cwd: authority.checkoutPath,
      });
      const staged = new Set(stagedOutput.split("\n").filter(Boolean));
      const alreadyStaged = !hasMutationChanges(current)
        && record.stagedPaths.every((path) => staged.has(path));
      if (alreadyStaged) {
        return;
      }
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task checkout changed after mutation verification.",
        details: { authorityId: authority.authorityId },
      });
    }
  }

}

function verifiedProvenance(value: unknown): MutationProvenance {
  const record = value as { provenance?: MutationProvenance } | undefined;
  if (!record?.provenance || record.provenance.unexpectedPaths.length > 0) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Mutation authority has no clean verified provenance.",
    });
  }
  return record.provenance;
}

function normalizePurpose(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function checkpointResponse(record: TaskCheckpointRecord): CheckpointMutationResponse {
  if (!record.checkpointHead) {
    throw new Error("Completed task checkpoint is missing its checkpoint HEAD.");
  }
  return {
    authorityId: record.authorityId,
    taskId: record.taskId,
    runId: record.runId,
    beforeHead: record.beforeHead,
    checkpointHead: record.checkpointHead,
    stagedPaths: record.stagedPaths,
    sessionGitlinkUpdated: false,
  };
}
