import type {
  MutationAuthorityStatus,
  MutationProvenance,
  ResolvedMutationTarget,
  TaskRepositoryLayout,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";

interface MutationAuthorityRow {
  authority_id: string;
  session_id: string;
  run_id: string;
  task_id: string;
  repository_layout: TaskRepositoryLayout;
  repository_path: string;
  task_request_id: string | null;
  checkout_path: string;
  canonical_repository: string;
  branch: string;
  before_head: string;
  lock_token_hash: string;
  authorized_targets_json: string;
  status: MutationAuthorityStatus;
  acquired_at: string;
  expires_at: string;
  verified_at: string | null;
  released_at: string | null;
  verification_json: string | null;
  last_error: string | null;
}

export interface MutationAuthorityRecord {
  authorityId: string;
  sessionId: string;
  runId: string;
  taskId: string;
  repositoryLayout: TaskRepositoryLayout;
  repositoryPath: string;
  taskRequestId?: string;
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  lockTokenHash: string;
  targets: ResolvedMutationTarget[];
  status: MutationAuthorityStatus;
  acquiredAt: string;
  expiresAt: string;
  verifiedAt?: string;
  releasedAt?: string;
  verification?: unknown;
  lastError?: string;
}

export function insertMutationAuthority(database: ContextDatabase, input: {
  sessionId: string;
  runId: string;
  taskId: string;
  repositoryLayout: TaskRepositoryLayout;
  repositoryPath: string;
  taskRequestId?: string;
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  lockTokenHash: string;
  targets: ResolvedMutationTarget[];
  acquiredAt: string;
  expiresAt: string;
}): MutationAuthorityRecord {
  assertTaskMutationUnlocked(database, input.taskId, input.acquiredAt);
  const row = database.prepare([
    "SELECT COUNT(*) + 1 AS next FROM task_mutation_authorities WHERE run_id = ?",
  ].join(" ")).get(input.runId) as { next: number };
  const authorityId = input.runId + "-M-" + String(Number(row.next)).padStart(4, "0");
  database.prepare([
    "INSERT INTO task_mutation_authorities(",
    "authority_id, session_id, run_id, task_id, repository_layout, repository_path,",
    "task_request_id, checkout_path, canonical_repository, branch, before_head,",
    "lock_token_hash, authorized_targets_json, status, acquired_at,",
    "expires_at, verified_at, released_at, verification_json, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)",
  ].join(" ")).run(
    authorityId,
    input.sessionId,
    input.runId,
    input.taskId,
    input.repositoryLayout,
    input.repositoryPath,
    input.taskRequestId ?? null,
    input.checkoutPath,
    input.canonicalRepository,
    input.branch,
    input.beforeHead,
    input.lockTokenHash,
    JSON.stringify(input.targets),
    input.acquiredAt,
    input.expiresAt,
  );
  const authority = readMutationAuthority(database, authorityId);
  if (!authority) {
    throw new Error("Inserted mutation authority could not be read.");
  }
  return authority;
}

export function assertTaskMutationUnlocked(
  database: ContextDatabase,
  taskId: string,
  at?: string,
): void {
  const blocking = readBlockingAuthority(database, taskId);
  if (blocking) {
    if (blocking.status === "active" && at && isExpired(blocking.expiresAt, at)) {
      updateMutationAuthorityVerification(database, blocking.authorityId, {
        status: "recovery_required",
        provenance: emptyProvenance(),
        outcome: "lease_expired",
        at,
        error: "Mutation authority lease expired before deterministic release.",
      });
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "The previous task mutation lease expired and requires recovery.",
        details: {
          taskId,
          authorityId: blocking.authorityId,
          runId: blocking.runId,
          expiredAt: blocking.expiresAt,
        },
      });
    }
    throw new GitContextServiceError({
      code: "TASK_LOCKED",
      message: "Task already has an active mutation authority.",
      retryable: true,
      details: {
        taskId,
        authorityId: blocking.authorityId,
        runId: blocking.runId,
        status: blocking.status,
      },
    });
  }
}

export function readMutationAuthority(
  database: ContextDatabase,
  authorityId: string,
): MutationAuthorityRecord | undefined {
  const row = database.prepare([
    authoritySelect(),
    "WHERE authority_id = ?",
  ].join(" ")).get(authorityId) as MutationAuthorityRow | undefined;
  return row ? mutationAuthorityRecord(row) : undefined;
}

export function readMutationAuthorityForRun(
  database: ContextDatabase,
  runId: string,
): MutationAuthorityRecord | undefined {
  const row = database.prepare([
    authoritySelect(),
    "WHERE run_id = ? ORDER BY acquired_at DESC LIMIT 1",
  ].join(" ")).get(runId) as MutationAuthorityRow | undefined;
  return row ? mutationAuthorityRecord(row) : undefined;
}

export function hasMutationAuthorityForRun(
  database: ContextDatabase,
  runId: string,
): boolean {
  const row = database.prepare([
    "SELECT 1 AS found FROM task_mutation_authorities WHERE run_id = ? LIMIT 1",
  ].join(" ")).get(runId) as { found: number } | undefined;
  return row?.found === 1;
}

export function updateMutationAuthorityVerification(
  database: ContextDatabase,
  authorityId: string,
  input: {
    status: MutationAuthorityStatus;
    provenance: MutationProvenance;
    outcome: string;
    at: string;
    error?: string;
    stateFingerprint?: string;
  },
): void {
  database.prepare([
    "UPDATE task_mutation_authorities",
    "SET status = ?, verified_at = ?, released_at = ?, verification_json = ?, last_error = ?",
    "WHERE authority_id = ?",
  ].join(" ")).run(
    input.status,
    input.at,
    input.status === "released" ? input.at : null,
    JSON.stringify({
      outcome: input.outcome,
      provenance: input.provenance,
      ...(input.stateFingerprint ? { stateFingerprint: input.stateFingerprint } : {}),
    }),
    input.error ?? null,
    authorityId,
  );
}

export function releaseCheckpointedMutationAuthority(
  database: ContextDatabase,
  authorityId: string,
  at: string,
): void {
  const result = database.prepare([
    "UPDATE task_mutation_authorities SET status = 'released', released_at = ?, last_error = NULL",
    "WHERE authority_id = ? AND status = 'verified'",
  ].join(" ")).run(at, authorityId);
  if (Number(result.changes) !== 1) {
    throw new Error("Verified mutation authority could not be released: " + authorityId);
  }
}

export const releaseVerifiedMutationAuthority = releaseCheckpointedMutationAuthority;

function readBlockingAuthority(
  database: ContextDatabase,
  taskId: string,
): MutationAuthorityRecord | undefined {
  const row = database.prepare([
    authoritySelect(),
    "WHERE task_id = ? AND status IN ('active', 'verified', 'recovery_required')",
    "LIMIT 1",
  ].join(" ")).get(taskId) as MutationAuthorityRow | undefined;
  return row ? mutationAuthorityRecord(row) : undefined;
}

function authoritySelect(): string {
  return [
    "SELECT authority_id, session_id, run_id, task_id, repository_layout,",
    "repository_path, task_request_id, checkout_path, canonical_repository,",
    "branch, before_head, lock_token_hash,",
    "authorized_targets_json, status, acquired_at, expires_at, verified_at,",
    "released_at, verification_json, last_error FROM task_mutation_authorities",
  ].join(" ");
}

function mutationAuthorityRecord(row: MutationAuthorityRow): MutationAuthorityRecord {
  return {
    authorityId: row.authority_id,
    sessionId: row.session_id,
    runId: row.run_id,
    taskId: row.task_id,
    repositoryLayout: row.repository_layout,
    repositoryPath: row.repository_path,
    ...(row.task_request_id ? { taskRequestId: row.task_request_id } : {}),
    checkoutPath: row.checkout_path,
    canonicalRepository: row.canonical_repository,
    branch: row.branch,
    beforeHead: row.before_head,
    lockTokenHash: row.lock_token_hash,
    targets: JSON.parse(row.authorized_targets_json) as ResolvedMutationTarget[],
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    ...(row.verification_json
      ? { verification: JSON.parse(row.verification_json) as unknown }
      : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function isExpired(expiresAt: string, at: string): boolean {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(at);
  return Number.isFinite(expires) && Number.isFinite(current) && expires <= current;
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
