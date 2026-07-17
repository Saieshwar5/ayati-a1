import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  MutationAuthority,
  MutationProvenance,
  SessionRef,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  executeIdempotent,
  readCompletedIdempotent,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import {
  hasMutationChanges,
  readMutationProvenance,
} from "../git/mutation-provenance.js";
import { runGit } from "../git/git-process.js";
import { ensureTaskSubmodule } from "../git/task-submodule.js";
import { verifyCanonicalTaskRepository } from "../git/task-repository.js";
import { resolveMutationTargets } from "../mutations/path-authority.js";
import {
  assertTaskMutationUnlocked,
  hasMutationAuthorityForRun,
  insertMutationAuthority,
  readMutationAuthority,
  updateMutationAuthorityVerification,
  type MutationAuthorityRecord,
} from "../repositories/mutation-authority-records.js";
import { bindActiveRunToTask } from "../repositories/run-records.js";
import { readTaskMount } from "../repositories/task-mount-records.js";
import {
  readTaskCatalogEntry,
  readTaskInitialization,
} from "../repositories/task-records.js";

const AUTHORITY_LIFETIME_MS = 15 * 60 * 1_000;

export class MutationBoundaryService {
  constructor(private readonly database: ContextDatabase) {}

  async acquire(
    input: AcquireMutationAuthorityRequest,
    session: SessionRef,
  ): Promise<AcquireMutationAuthorityResponse> {
    const completed = readCompletedIdempotent<AcquireMutationAuthorityResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "acquire_mutation_authority",
      payload: input,
    });
    if (completed) {
      return completed;
    }
    assertTaskMutationUnlocked(this.database, input.taskId);
    const task = readTaskCatalogEntry(this.database, input.taskId);
    const taskRecord = readTaskInitialization(this.database, input.taskId);
    const mount = readTaskMount(this.database, input.sessionId, input.taskId);
    if (!task || task.status !== "active" || !taskRecord) {
      throw mutationRequiresTask(input, "Mutation requires an active task.");
    }
    if (task.layoutVersion !== "legacy_independent_v0") {
      throw new GitContextServiceError({
        code: "SERVICE_NOT_READY",
        message: "V1 task mutation is not enabled in this implementation slice.",
        details: { taskId: task.taskId, layoutVersion: task.layoutVersion },
      });
    }
    if (!mount || mount.status !== "ready" || !mount.mountedHead) {
      throw mutationRequiresTask(input, "Mutation requires a ready task checkout mount.");
    }
    if (input.expectedTaskHead && input.expectedTaskHead !== task.head) {
      throw new GitContextServiceError({
        code: "TASK_HEAD_MISMATCH",
        message: "Task HEAD does not match the mutation request expectation.",
        retryable: true,
        details: {
          taskId: task.taskId,
          expectedHead: input.expectedTaskHead,
          actualHead: task.head,
        },
      });
    }
    if (mount.mountedHead !== task.head) {
      throw new GitContextServiceError({
        code: "TASK_HEAD_MISMATCH",
        message: "Mounted checkout HEAD does not match the task catalog.",
        retryable: true,
        details: {
          taskId: task.taskId,
          mountedHead: mount.mountedHead,
          taskHead: task.head,
        },
      });
    }
    await verifyCanonicalTaskRepository(taskRecord);
    if (!hasMutationAuthorityForRun(this.database, input.runId)) {
      await ensureTaskSubmodule({ session, task, mount });
    } else {
      await verifyActiveRunCheckout(mount.workingPath, task.head, task.branch, task.taskId);
    }
    const targets = await resolveMutationTargets(mount.workingPath, input.targets);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = expirationTime(input.at);

    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "acquire_mutation_authority",
      payload: input,
      now: input.at,
      execute: () => {
        bindActiveRunToTask(
          this.database,
          input.sessionId,
          input.runId,
          input.taskId,
        );
        const record = insertMutationAuthority(this.database, {
          sessionId: input.sessionId,
          runId: input.runId,
          taskId: input.taskId,
          checkoutPath: mount.workingPath,
          canonicalRepository: task.repositoryPath,
          branch: task.branch,
          beforeHead: task.head,
          lockTokenHash: tokenHash(token),
          targets,
          acquiredAt: input.at,
          expiresAt,
        });
        return { authority: mutationAuthority(record, token) };
      },
    });
  }

  async verify(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    const completed = readCompletedIdempotent<VerifyMutationResponse>({
      database: this.database,
      requestId: input.requestId,
      operation: "verify_mutation",
      payload: input,
    });
    if (completed) {
      return completed;
    }
    const authority = readMutationAuthority(this.database, input.authorityId);
    if (!authority) {
      throw new GitContextServiceError({
        code: "NOT_FOUND",
        message: "Mutation authority does not exist.",
        details: { authorityId: input.authorityId },
      });
    }
    verifyMutationLockToken(authority, input.lockToken);
    if (authority.status !== "active") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Mutation authority is not active.",
        details: { authorityId: authority.authorityId, status: authority.status },
      });
    }
    await this.verifyCheckoutIdentity(authority, input.at);
    const provenance = await readMutationProvenance(
      authority.checkoutPath,
      authority.targets,
      "index",
    );
    return executeIdempotent({
      database: this.database,
      requestId: input.requestId,
      operation: "verify_mutation",
      payload: input,
      now: input.at,
      execute: () => this.reduceVerification(authority, input, provenance),
    });
  }

  private async verifyCheckoutIdentity(
    authority: MutationAuthorityRecord,
    at: string,
  ): Promise<void> {
    const head = await runGit(["rev-parse", "HEAD"], { cwd: authority.checkoutPath });
    let branch: string | undefined;
    try {
      branch = await runGit(["symbolic-ref", "--short", "HEAD"], {
        cwd: authority.checkoutPath,
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
      error: "Checkout HEAD or branch changed while mutation authority was active.",
    });
    throw new GitContextServiceError({
      code: head !== authority.beforeHead ? "TASK_HEAD_MISMATCH" : "RECOVERY_REQUIRED",
      message: "Task checkout identity changed while mutation authority was active.",
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
        status: "released",
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

async function verifyActiveRunCheckout(
  checkoutPath: string,
  expectedHead: string,
  expectedBranch: string,
  taskId: string,
): Promise<void> {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: checkoutPath });
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: checkoutPath });
  if (head !== expectedHead || branch !== expectedBranch) {
    throw new GitContextServiceError({
      code: "TASK_HEAD_MISMATCH",
      message: "Active task-run checkout identity changed between verified steps.",
      details: { taskId, expectedHead, actualHead: head, expectedBranch, actualBranch: branch },
    });
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
    checkoutPath: record.checkoutPath,
    canonicalRepository: record.canonicalRepository,
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
    code: "MUTATION_REQUIRES_TASK",
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
