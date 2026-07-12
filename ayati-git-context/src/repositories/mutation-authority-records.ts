import type {
  MutationAuthorityStatus,
  MutationProvenance,
  ResolvedMutationTarget,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";

interface MutationAuthorityRow {
  authority_id: string;
  session_id: string;
  run_id: string;
  task_id: string;
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
  checkoutPath: string;
  canonicalRepository: string;
  branch: string;
  beforeHead: string;
  lockTokenHash: string;
  targets: ResolvedMutationTarget[];
  acquiredAt: string;
  expiresAt: string;
}): MutationAuthorityRecord {
  assertTaskMutationUnlocked(database, input.taskId);
  const row = database.prepare([
    "SELECT COUNT(*) + 1 AS next FROM task_mutation_authorities WHERE run_id = ?",
  ].join(" ")).get(input.runId) as { next: number };
  const authorityId = input.runId + "-M-" + String(Number(row.next)).padStart(4, "0");
  database.prepare([
    "INSERT INTO task_mutation_authorities(",
    "authority_id, session_id, run_id, task_id, checkout_path, canonical_repository,",
    "branch, before_head, lock_token_hash, authorized_targets_json, status, acquired_at,",
    "expires_at, verified_at, released_at, verification_json, last_error",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)",
  ].join(" ")).run(
    authorityId,
    input.sessionId,
    input.runId,
    input.taskId,
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
): void {
  const blocking = readBlockingAuthority(database, taskId);
  if (blocking) {
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

export function updateMutationAuthorityVerification(
  database: ContextDatabase,
  authorityId: string,
  input: {
    status: MutationAuthorityStatus;
    provenance: MutationProvenance;
    outcome: string;
    at: string;
    error?: string;
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
    JSON.stringify({ outcome: input.outcome, provenance: input.provenance }),
    input.error ?? null,
    authorityId,
  );
}

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
    "SELECT authority_id, session_id, run_id, task_id, checkout_path,",
    "canonical_repository, branch, before_head, lock_token_hash,",
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
