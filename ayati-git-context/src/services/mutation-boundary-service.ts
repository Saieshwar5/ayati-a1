import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  MutationAuthority,
  MutationProvenance,
  TaskCatalogEntry,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
  executeIdempotent,
  hasRecoverableIdempotencyRequest,
  markRecoverableIdempotencyFailed,
  readCompletedIdempotent,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  hasMutationChanges,
  readMutationProvenance,
} from "../git/mutation-provenance.js";
import { runGit } from "../git/git-process.js";
import { readSimpleTaskMutationState } from "../git/simple-task-repository-transaction.js";
import { resolveMutationTargets } from "../mutations/path-authority.js";
import {
  assertTaskMutationUnlocked,
  insertMutationAuthority,
  readMutationAuthority,
  updateMutationAuthorityVerification,
  type MutationAuthorityRecord,
} from "../repositories/mutation-authority-records.js";
import { readRunEvidence } from "../repositories/run-records.js";
import {
  readTaskRequestRoutePlan,
  updateTaskRequestRoutePlan,
} from "../repositories/task-request-route-plan-records.js";
import { readTaskCatalogEntry } from "../repositories/task-records.js";
import { validateTaskRepository } from "../tasks/task-repository-validator.js";
import { resolvePlannedTaskRequestState } from "../tasks/planned-task-request.js";

const AUTHORITY_LIFETIME_MS = 15 * 60 * 1_000;

export class MutationBoundaryService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly taskRoot: string,
  ) {}

  async acquire(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    if (!/^T-\d{8}-\d{4}$/.test(input.taskId)) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Mutation authority supports only V1 T-* task repositories.",
        details: { taskId: input.taskId },
      });
    }
    const completed = readCompletedIdempotent<AcquireMutationAuthorityResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "acquire_mutation_authority",
      payload: input,
    });
    if (completed) {
      return completed;
    }
    const task = readTaskCatalogEntry(this.database, input.taskId);
    if (!task || task.status !== "active") {
      throw mutationRequiresTask(input, "Mutation requires an active task.");
    }
    return await this.acquireSimpleTask(input, task);
  }

  private async acquireSimpleTask(
    input: AcquireMutationAuthorityRequest,
    task: TaskCatalogEntry,
  ): Promise<AcquireMutationAuthorityResponse> {
    if (!input.expectedTaskHead) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "V1 mutation authority requires the expected task HEAD.",
        details: { taskId: task.taskId },
      });
    }
    if (!input.taskRequestId) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "V1 mutation authority requires the active task request identity.",
        details: { taskId: task.taskId },
      });
    }
    if (input.expectedTaskHead !== task.head) {
      throw taskHeadMismatch(input.taskId, input.expectedTaskHead, task.head);
    }
    const boundRun = readRunEvidence(this.database, input.runId);
    if (!boundRun
      || boundRun.status !== "running"
      || boundRun.sessionId !== input.sessionId
      || boundRun.taskBinding?.taskId !== input.taskId
      || boundRun.taskBinding.taskRequestId !== input.taskRequestId) {
      throw mutationRequiresTask(
        input,
        "Mutation authority requires the run's immutable task/request binding.",
      );
    }
    const routePlan = readTaskRequestRoutePlan(this.database, input.runId);
    if (routePlan && (routePlan.sessionId !== input.sessionId
      || routePlan.taskId !== input.taskId
      || routePlan.taskRequestId !== input.taskRequestId
      || routePlan.baseHead !== input.expectedTaskHead
      || !["planned", "authority_acquired"].includes(routePlan.phase))) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "V1 mutation authority does not match the pending request plan.",
        details: { runId: input.runId, taskId: input.taskId, phase: routePlan.phase },
      });
    }
    const recoveringAuthority = hasRecoverableIdempotencyRequest({
      database: this.database,
      requestId: input.requestId,
      operation: "acquire_mutation_authority",
      payload: input,
    });
    if (!recoveringAuthority) {
      assertTaskMutationUnlocked(this.database, input.taskId, input.at);
    }
    const before = await this.validateSimpleTaskState(input, task);
    requireCleanSimpleTask(before, input.taskId);
    const targets = await resolveMutationTargets(before.repositoryPath, input.targets);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = expirationTime(input.at);
    const pending = beginRecoverableIdempotent<AcquireMutationAuthorityResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "acquire_mutation_authority",
      payload: input,
      now: input.at,
      execute: () => {
        const record = insertMutationAuthority(this.database, {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          repositoryPath: before.repositoryPath,
          taskRequestId: input.taskRequestId,
          branch: before.branch,
          beforeHead: before.head,
          lockTokenHash: tokenHash(token),
          targets,
          acquiredAt: input.at,
          expiresAt,
        });
        return { authority: mutationAuthority(record, token) };
      },
    });

    const authority = readMutationAuthority(
      this.database,
      pending.result.authority.authorityId,
    );
    if (!authority || authority.status !== "active") {
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "V1 mutation authority could not resume from its persisted lease state.",
        details: {
          taskId: input.taskId,
          authorityId: pending.result.authority.authorityId,
          status: authority?.status ?? "missing",
        },
      });
    }

    try {
      const after = await this.validateSimpleTaskState(input, task);
      requireCleanSimpleTask(after, input.taskId);
      const recheckedTargets = await resolveMutationTargets(after.repositoryPath, input.targets);
      if (JSON.stringify(recheckedTargets) !== JSON.stringify(authority.targets)) {
        throw new GitContextServiceError({
          code: "RECOVERY_REQUIRED",
          message: "V1 mutation targets changed while the task lock was acquired.",
          details: { taskId: input.taskId, authorityId: authority.authorityId },
        });
      }
      this.database.transaction(() => {
        const run = readRunEvidence(this.database, input.runId);
        if (!run
          || run.status !== "running"
          || run.sessionId !== input.sessionId
          || run.taskBinding?.taskId !== input.taskId
          || run.taskBinding.taskRequestId !== input.taskRequestId) {
          throw mutationRequiresTask(
            input,
            "Mutation authority requires the run's immutable task/request binding.",
          );
        }
        if (routePlan) {
          updateTaskRequestRoutePlan(this.database, {
            runId: input.runId,
            phase: "authority_acquired",
            authorityId: authority.authorityId,
            at: input.at,
          });
        }
      });
      return completeRecoverableIdempotent({
        database: this.database,
        requestId: input.requestId,
        result: pending.result,
        now: input.at,
      });
    } catch (error) {
      this.database.transaction(() => {
        updateMutationAuthorityVerification(this.database, authority.authorityId, {
          status: "recovery_required",
          provenance: emptyProvenance(),
          outcome: "post_lock_validation_failed",
          at: input.at,
          error: error instanceof Error ? error.message : String(error),
        });
        if (routePlan) {
          updateTaskRequestRoutePlan(this.database, {
            runId: input.runId,
            phase: "recovery_required",
            authorityId: authority.authorityId,
            error: error instanceof Error ? error.message : String(error),
            at: input.at,
          });
        }
      });
      markRecoverableIdempotencyFailed({ database: this.database, requestId: input.requestId });
      throw error;
    }
  }

  private async validateSimpleTaskState(
    input: AcquireMutationAuthorityRequest,
    task: NonNullable<ReturnType<typeof readTaskCatalogEntry>>,
  ) {
    if (input.expectedTaskHead !== task.head) {
      throw taskHeadMismatch(input.taskId, input.expectedTaskHead, task.head);
    }
    const validation = await validateTaskRepository({
      taskRoot: this.taskRoot,
      repositoryPath: task.repositoryPath,
      expectedTaskId: task.taskId,
      placement: task.placement,
      trustedRoot: task.trustedRoot,
      requestReadMode: "all",
    });
    if (validation.head !== task.head) {
      throw taskHeadMismatch(input.taskId, task.head, validation.head);
    }
    if (validation.branch !== task.branch) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "V1 task branch does not match its catalog identity.",
        details: {
          taskId: task.taskId,
          expectedBranch: task.branch,
          actualBranch: validation.branch,
        },
      });
    }
    const routePlan = readTaskRequestRoutePlan(this.database, input.runId);
    const effectiveRequest = routePlan
      ? resolvePlannedTaskRequestState(routePlan, validation).taskRequest
      : validation.currentRequest;
    if (effectiveRequest?.id !== input.taskRequestId) {
      throw new GitContextServiceError({
        code: "TASK_CURRENT_REQUEST_INVALID",
        message: "Mutation request does not match the task repository's active request.",
        details: {
          taskId: task.taskId,
          requestedTaskRequestId: input.taskRequestId,
          activeTaskRequestId: effectiveRequest?.id ?? null,
        },
      });
    }
    return validation;
  }

  async verify(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    const authority = readMutationAuthority(this.database, input.authorityId);
    if (!authority) {
      throw new GitContextServiceError({
        code: "NOT_FOUND",
        message: "Mutation authority does not exist.",
        details: { authorityId: input.authorityId },
      });
    }
    if (!/^T-\d{8}-\d{4}$/.test(authority.taskId)
      || !authority.taskRequestId) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Mutation verification supports only V1 task authorities.",
        details: { authorityId: authority.authorityId, taskId: authority.taskId },
      });
    }
    const completed = readCompletedIdempotent<VerifyMutationResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "verify_mutation",
      payload: input,
    });
    if (completed) return completed;
    verifyMutationLockToken(authority, input.lockToken);
    if (authority.status !== "active") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Mutation authority is not active.",
        details: { authorityId: authority.authorityId, status: authority.status },
      });
    }
    await this.verifyRepositoryIdentity(authority, input.at);
    const provenance = await readMutationProvenance(
      authority.repositoryPath,
      authority.targets,
      "head",
      {
        excludedPathPrefixes: [".ayati/inbox/"],
        includedPaths: [".ayati/inbox/.gitkeep"],
      },
    );
    const stateFingerprint = await readSimpleTaskMutationState(
      authority.repositoryPath,
      mutationPaths(provenance),
    );
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "verify_mutation",
      payload: input,
      now: input.at,
      execute: () => this.reduceVerification(
        authority,
        input,
        provenance,
        stateFingerprint,
      ),
    });
  }

  private async verifyRepositoryIdentity(
    authority: MutationAuthorityRecord,
    at: string,
  ): Promise<void> {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: authority.repositoryPath });
    let branch: string | undefined;
    try {
      branch = await runGit(["symbolic-ref", "--short", "HEAD"], {
        cwd: authority.repositoryPath,
      });
    } catch {
      branch = undefined;
    }
    if (head === authority.beforeHead && branch === authority.branch) {
      return;
    }
    const provenance = emptyProvenance();
    updateMutationAuthorityVerification(this.database, authority.authorityId, {
      status: "recovery_required",
      provenance,
      outcome: "checkout_identity_changed",
      at,
      error: "Repository HEAD or branch changed while mutation authority was active.",
    });
    throw new GitContextServiceError({
      code: head !== authority.beforeHead ? "TASK_HEAD_MISMATCH" : "RECOVERY_REQUIRED",
      message: "Task repository identity changed while mutation authority was active.",
      retryable: false,
      details: {
        authorityId: authority.authorityId,
        expectedHead: authority.beforeHead,
        actualHead: head,
        expectedBranch: authority.branch,
        actualBranch: branch ?? null,
      },
    });
  }

  private reduceVerification(
    authority: MutationAuthorityRecord,
    input: VerifyMutationRequest,
    provenance: MutationProvenance,
    stateFingerprint?: string,
  ): VerifyMutationResponse {
    verifyMutationLockToken(authority, input.lockToken);
    if (authority.status !== "active") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Mutation authority is not active.",
        details: {
          authorityId: authority.authorityId,
          status: authority.status,
        },
      });
    }
    const hasChanges = hasMutationChanges(provenance);
    let result: Omit<VerifyMutationResponse, "authorityId" | "provenance">;
    if (!hasChanges) {
      result = {
        status: input.toolStatus === "completed"
          ? "verified"
          : "released",
        verified: input.toolStatus === "completed",
        outcome: "no_changes",
      };
    } else if (input.toolStatus === "failed") {
      result = {
        status: "recovery_required",
        verified: false,
        outcome: "failed_with_changes",
      };
    } else if (provenance.unexpectedPaths.length > 0) {
      result = {
        status: "recovery_required",
        verified: false,
        outcome: "unexpected_changes",
      };
    } else {
      result = {
        status: "verified",
        verified: true,
        outcome: "verified_changes",
      };
    }
    updateMutationAuthorityVerification(this.database, authority.authorityId, {
      status: result.status,
      provenance,
      outcome: result.outcome,
      at: input.at,
      ...(stateFingerprint ? { stateFingerprint } : {}),
      ...(result.status === "recovery_required"
        ? { error: "Mutation requires deterministic recovery before another task owner can proceed." }
        : {}),
    });
    return {
      authorityId: authority.authorityId,
      ...result,
      provenance,
    };
  }
}

function mutationAuthority(
  record: MutationAuthorityRecord,
  token: string,
): MutationAuthority {
  return {
    authorityId: record.authorityId,
    lockToken: token,
    sessionId: record.sessionId,
    runId: record.runId,
    taskId: record.taskId,
    repositoryPath: record.repositoryPath,
    ...(record.taskRequestId ? { taskRequestId: record.taskRequestId } : {}),
    branch: record.branch,
    beforeHead: record.beforeHead,
    targets: record.targets,
    status: record.status,
    expiresAt: record.expiresAt,
  };
}

export function verifyMutationLockToken(
  authority: MutationAuthorityRecord,
  token: string,
): void {
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(authority.lockTokenHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Mutation authority token is invalid.",
      details: { authorityId: authority.authorityId },
    });
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expirationTime(at: string): string {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Mutation authority time must be a valid timestamp.",
    });
  }
  return new Date(timestamp + AUTHORITY_LIFETIME_MS).toISOString();
}

function mutationRequiresTask(
  input: { sessionId: string; runId: string; taskId: string },
  message: string,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "MUTATION_REQUIRES_TASK_BINDING",
    message,
    details: {
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
    },
  });
}

function emptyProvenance(): MutationProvenance {
  return {
    created: [],
    modified: [],
    deleted: [],
    renamed: [],
    unexpectedPaths: [],
  };
}

function requireCleanSimpleTask(
  validation: { health: string; workingTreeChanges: string[] },
  taskId: string,
): void {
  if (validation.health === "ready") return;
  throw new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message: "V1 task repository contains unjournaled working-tree changes.",
    details: { taskId, workingTreeChanges: validation.workingTreeChanges },
  });
}

function taskHeadMismatch(
  taskId: string,
  expectedHead: string | undefined,
  actualHead: string,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "TASK_HEAD_MISMATCH",
    message: "Task HEAD does not match the mutation request expectation.",
    retryable: true,
    details: { taskId, expectedHead: expectedHead ?? null, actualHead },
  });
}

function mutationPaths(provenance: MutationProvenance): string[] {
  return [...new Set([
    ...provenance.created,
    ...provenance.modified,
    ...provenance.deleted,
    ...provenance.renamed.flatMap((entry) => [entry.from, entry.to]),
  ])].sort();
}
