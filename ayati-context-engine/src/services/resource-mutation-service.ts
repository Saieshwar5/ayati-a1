import { createHash, randomBytes } from "node:crypto";
import type {
  PrepareResourceMutationRequest,
  PrepareResourceMutationResponse,
  ResourceEvent,
  ResourceRef,
  ResourceVersion,
  VerifyResourceMutationRequest,
  VerifyResourceMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  readResource,
  recordResourceObservation,
} from "../repositories/resource-records.js";
import { readRunEvidence } from "../repositories/run-records.js";
import {
  compareMutationSnapshots,
  mutationPathIsWithin,
  mutationPathsOverlap,
  parseMutationSnapshot,
  resolveMutationTargets,
  snapshotMutationOperation,
  type ResolvedMutationTarget,
} from "./resource-mutation-snapshot.js";

const LEASE_DURATION_MS = 15 * 60 * 1_000;

interface OperationRow {
  operation_id: string;
  lease_id: string;
  run_id: string;
  call_id: string;
  tool: string;
  effect: "workspace_mutation" | "external_mutation" | "destructive";
  targets_json: string;
  before_json: string;
  status: "prepared" | "verified" | "no_change" | "recovery_required";
  lock_token_hash: string;
  stream_id: string;
  workstream_id: string;
  bound_request_id: string;
  lease_status: "active" | "recovery_required" | "released";
}

export class ResourceMutationService {
  constructor(private readonly database: ContextDatabase) {}

  async prepare(
    input: PrepareResourceMutationRequest,
    onAuthorityPrepared?: (response: PrepareResourceMutationResponse) => void,
  ): Promise<PrepareResourceMutationResponse> {
    const resources = this.requireMutationResources(input);
    const streamId = readRunEvidence(this.database, input.runId)!.streamId;
    const targets = await resolveMutationTargets(resources, input.targets);
    const leaseId = stableId("RL", input.runId + "\u0000" + input.callId);
    const operationId = stableId("RM", input.runId + "\u0000" + input.callId);
    const lockToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.parse(input.at) + LEASE_DURATION_MS).toISOString();

    this.database.transaction(() => {
      this.assertScopesAvailable(targets);
      this.database.prepare([
        "INSERT INTO resource_mutation_leases(",
        "lease_id, stream_id, run_id, workstream_id, bound_request_id, lock_token_hash, status,",
        "acquired_at, expires_at, released_at, last_error",
        ") VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)",
      ].join(" ")).run(
        leaseId,
        streamId,
        input.runId,
        input.workstreamId,
        input.activeRequestId,
        tokenHash(lockToken),
        input.at,
        expiresAt,
      );
      for (const target of targets) {
        this.database.prepare([
          "INSERT INTO resource_mutation_locks(lease_id, resource_id, canonical_scope, acquired_at)",
          "VALUES (?, ?, ?, ?)",
        ].join(" ")).run(leaseId, target.resourceId, target.resolvedPath, input.at);
      }
      this.database.prepare([
        "INSERT INTO resource_mutation_operations(",
        "operation_id, lease_id, run_id, call_id, tool, effect, targets_json, before_json,",
        "after_json, verification_json, event_plan_json, tool_status, status, created_at, verified_at, last_error",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, 'null', NULL, NULL, NULL, NULL, 'prepared', ?, NULL, NULL)",
      ].join(" ")).run(
        operationId,
        leaseId,
        input.runId,
        input.callId,
        input.tool,
        input.effect,
        JSON.stringify(targets),
        input.at,
      );
    });

    const response: PrepareResourceMutationResponse = {
      leaseId,
      operationId,
      lockToken,
      targets: targets.map((target) => ({
        resourceId: target.resourceId,
        ...(target.relativePath ? { relativePath: target.relativePath } : {}),
        kind: target.kind,
        ...(target.expectedVersionKey ? { expectedVersionKey: target.expectedVersionKey } : {}),
        resolvedPath: target.resolvedPath,
      })),
      expiresAt,
    };

    try {
      const snapshot = await snapshotMutationOperation(targets, input.at);
      this.database.transaction(() => {
        const result = this.database.prepare([
          "UPDATE resource_mutation_operations SET before_json = ?",
          "WHERE operation_id = ? AND status = 'prepared'",
        ].join(" ")).run(JSON.stringify(snapshot), operationId);
        if (Number(result.changes) !== 1) throw new Error("Mutation operation disappeared while preparing.");
      });
      onAuthorityPrepared?.(response);
    } catch (error) {
      this.releaseFailedPreparation(operationId, leaseId, input.at, error);
      throw error;
    }

    return response;
  }

  operationContext(operationId: string): {
    streamId: string;
    runId: string;
    workstreamId: string;
    operationStatus: OperationRow["status"];
    leaseStatus: OperationRow["lease_status"];
  } | undefined {
    const operation = this.readOperation(operationId);
    return operation
      ? {
          streamId: operation.stream_id,
          runId: operation.run_id,
          workstreamId: operation.workstream_id,
          operationStatus: operation.status,
          leaseStatus: operation.lease_status,
        }
      : undefined;
  }

  async verify(input: VerifyResourceMutationRequest): Promise<VerifyResourceMutationResponse> {
    const operation = this.readOperation(input.operationId);
    if (!operation || operation.lease_id !== input.leaseId) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_MUTATION_NOT_FOUND",
        message: "Resource mutation operation does not exist.",
        details: { operationId: input.operationId },
      });
    }
    if (operation.status === "verified" || operation.status === "no_change") {
      return {
        leaseId: operation.lease_id,
        operationId: operation.operation_id,
        status: operation.status,
        verified: true,
        events: this.readOperationEvents(operation.run_id, operation.call_id),
      };
    }
    if (operation.status === "recovery_required" || operation.lease_status !== "active") {
      return {
        leaseId: operation.lease_id,
        operationId: operation.operation_id,
        status: "recovery_required",
        verified: false,
        events: [],
      };
    }
    if (!constantTimeEqual(operation.lock_token_hash, tokenHash(input.lockToken))) {
      throw new ContextEngineServiceError({
        code: "MUTATION_LOCK_INVALID",
        message: "Resource mutation capability token is invalid.",
      });
    }
    const before = parseMutationSnapshot(operation.before_json);
    if (!before) {
      this.markRecoveryRequired(operation.operation_id, operation.lease_id, "Missing before snapshot.");
      return {
        leaseId: operation.lease_id,
        operationId: operation.operation_id,
        status: "recovery_required",
        verified: false,
        events: [],
      };
    }

    let after: Awaited<ReturnType<typeof snapshotMutationOperation>>;
    try {
      after = await snapshotMutationOperation(before.targets, input.at);
    } catch (error) {
      this.markRecoveryRequired(operation.operation_id, operation.lease_id, error);
      return {
        leaseId: operation.lease_id,
        operationId: operation.operation_id,
        status: "recovery_required",
        verified: false,
        events: [],
      };
    }
    const comparison = compareMutationSnapshots(before, after);
    const failedWithChanges = input.toolStatus === "failed" && comparison.changedPaths.length > 0;
    if (comparison.unexpectedPaths.length > 0 || failedWithChanges) {
      const verification = {
        verified: false,
        toolStatus: input.toolStatus,
        changedPaths: comparison.changedPaths,
        unexpectedPaths: comparison.unexpectedPaths,
        failedWithChanges,
      };
      this.database.transaction(() => {
        this.database.prepare([
          "UPDATE resource_mutation_operations SET after_json = ?, verification_json = ?,",
          "tool_status = ?, status = 'recovery_required', verified_at = ?, last_error = ?",
          "WHERE operation_id = ?",
        ].join(" ")).run(
          JSON.stringify(after),
          JSON.stringify(verification),
          input.toolStatus,
          input.at,
          failedWithChanges ? "Mutation tool failed after changing resources." : "Unexpected resource changes detected.",
          operation.operation_id,
        );
        this.database.prepare([
          "UPDATE resource_mutation_leases SET status = 'recovery_required', last_error = ?",
          "WHERE lease_id = ?",
        ].join(" ")).run(JSON.stringify(verification), operation.lease_id);
        this.database.prepare([
          "UPDATE runs SET status = 'recovery_required' WHERE run_id = ? AND status = 'running'",
        ].join(" ")).run(operation.run_id);
      });
      return {
        leaseId: operation.lease_id,
        operationId: operation.operation_id,
        status: "recovery_required",
        verified: false,
        events: [],
      };
    }

    const changed = comparison.changedPaths.length > 0;
    const events = this.database.transaction(() => {
      const recorded: ResourceEvent[] = [];
      if (changed) {
        for (const afterResource of after.resources) {
          const beforeResource = before.resources.find(
            (candidate) => candidate.resourceId === afterResource.resourceId,
          );
          if (!beforeResource || beforeResource.version.key === afterResource.version.key) continue;
          const type = eventType(beforeResource.version, afterResource.version);
          recorded.push(recordResourceObservation(this.database, {
            resourceId: afterResource.resourceId,
            runId: operation.run_id,
            beforeVersion: beforeResource.version,
            afterVersion: afterResource.version,
            type,
            verification: {
              operationId: operation.operation_id,
              callId: operation.call_id,
              changedPaths: comparison.changedPaths.filter(
                (path) => mutationPathIsWithin(afterResource.rootPath, path),
              ),
            },
            summary: mutationSummary(type, afterResource.resourceId),
            at: input.at,
            callId: operation.call_id,
            workstreamId: operation.workstream_id,
            requestId: operation.bound_request_id,
          }));
          this.database.prepare([
            "INSERT INTO resource_accesses(resource_id, run_id, access_kind, accessed_at)",
            "VALUES (?, ?, 'mutated', ?) ON CONFLICT(resource_id, run_id, access_kind)",
            "DO UPDATE SET accessed_at = excluded.accessed_at",
          ].join(" ")).run(afterResource.resourceId, operation.run_id, input.at);
        }
      }
      const status = changed ? "verified" : "no_change";
      const verification = {
        verified: true,
        toolStatus: input.toolStatus,
        changedPaths: comparison.changedPaths,
        unexpectedPaths: [],
      };
      this.database.prepare([
        "UPDATE resource_mutation_operations SET after_json = ?, verification_json = ?,",
        "event_plan_json = ?, tool_status = ?, status = ?, verified_at = ?, last_error = NULL",
        "WHERE operation_id = ? AND status = 'prepared'",
      ].join(" ")).run(
        JSON.stringify(after),
        JSON.stringify(verification),
        JSON.stringify(recorded),
        input.toolStatus,
        status,
        input.at,
        operation.operation_id,
      );
      this.database.prepare([
        "UPDATE resource_mutation_leases SET status = 'released', released_at = ?, last_error = NULL",
        "WHERE lease_id = ? AND status = 'active'",
      ].join(" ")).run(input.at, operation.lease_id);
      return recorded;
    });
    return {
      leaseId: operation.lease_id,
      operationId: operation.operation_id,
      status: changed ? "verified" : "no_change",
      verified: true,
      events,
    };
  }

  recoverInterrupted(at: string): string[] {
    this.recoverSafePreExecutionFailures(at);
    const rows = this.database.prepare([
      "SELECT lease_id, run_id FROM resource_mutation_leases WHERE status = 'active'",
    ].join(" ")).all() as unknown as Array<{ lease_id: string; run_id: string }>;
    for (const row of rows) {
      this.database.transaction(() => {
        this.database.prepare([
          "UPDATE resource_mutation_leases SET status = 'recovery_required',",
          "last_error = 'Daemon stopped while mutation authority was active.' WHERE lease_id = ?",
        ].join(" ")).run(row.lease_id);
        this.database.prepare([
          "UPDATE resource_mutation_operations SET status = 'recovery_required',",
          "last_error = 'Daemon stopped before deterministic mutation verification.'",
          "WHERE lease_id = ? AND status = 'prepared'",
        ].join(" ")).run(row.lease_id);
        this.database.prepare([
          "UPDATE runs SET status = 'recovery_required' WHERE run_id = ? AND status = 'running'",
        ].join(" ")).run(row.run_id);
      });
    }
    return rows.map((row) => row.run_id);
  }

  private requireMutationResources(input: PrepareResourceMutationRequest): Map<string, ResourceRef> {
    const run = this.database.prepare([
      "SELECT workstream_id, bound_request_id, status FROM runs WHERE run_id = ?",
    ].join(" ")).get(input.runId) as {
      workstream_id: string | null;
      bound_request_id: string | null;
      status: string;
    } | undefined;
    if (!run || run.status !== "running" || run.workstream_id !== input.workstreamId
      || run.bound_request_id !== input.activeRequestId) {
      throw new ContextEngineServiceError({
        code: "MUTATION_REQUIRES_WORKSTREAM_BINDING",
        message: "Resource mutation requires the matching active workstream/request binding.",
        details: { runId: input.runId, workstreamId: input.workstreamId },
      });
    }
    const resources = new Map<string, ResourceRef>();
    for (const target of input.targets) {
      const binding = this.database.prepare([
        "SELECT access FROM workstream_resources",
        "WHERE workstream_id = ? AND resource_id = ? AND access = 'mutate' LIMIT 1",
      ].join(" ")).get(input.workstreamId, target.resourceId) as { access: string } | undefined;
      const resource = readResource(this.database, target.resourceId);
      if (!binding || !resource || resource.locator.kind !== "filesystem") {
        throw new ContextEngineServiceError({
          code: "RESOURCE_MUTATION_UNAVAILABLE",
          message: "Mutation target is not a mutable resource bound to this workstream.",
          details: { resourceId: target.resourceId },
        });
      }
      if (target.expectedVersionKey && target.expectedVersionKey !== resource.version.key) {
        throw new ContextEngineServiceError({
          code: "RESOURCE_VERSION_MISMATCH",
          message: "Mutation target version changed before authority was prepared.",
          details: {
            resourceId: target.resourceId,
            expectedVersionKey: target.expectedVersionKey,
            actualVersionKey: resource.version.key,
          },
        });
      }
      resources.set(target.resourceId, resource);
    }
    return resources;
  }

  private assertScopesAvailable(targets: ResolvedMutationTarget[]): void {
    const active = this.database.prepare([
      "SELECT l.resource_id, l.canonical_scope, a.run_id FROM resource_mutation_locks l",
      "JOIN resource_mutation_leases a ON a.lease_id = l.lease_id",
      "WHERE a.status IN ('active', 'recovery_required')",
    ].join(" ")).all() as unknown as Array<{
      resource_id: string;
      canonical_scope: string;
      run_id: string;
    }>;
    const conflict = active.find((lock) => targets.some((target) =>
      lock.resource_id === target.resourceId
      && mutationPathsOverlap(lock.canonical_scope, target.resolvedPath)));
    if (conflict) {
      throw new ContextEngineServiceError({
        code: "MUTATION_AUTHORITY_CONFLICT",
        message: "A resource mutation scope is already locked.",
        details: {
          resourceId: conflict.resource_id,
          scope: conflict.canonical_scope,
          activeRunId: conflict.run_id,
        },
      });
    }
  }

  private readOperation(operationId: string): OperationRow | undefined {
    return this.database.prepare([
      "SELECT o.operation_id, o.lease_id, o.run_id, o.call_id, o.tool, o.effect,",
      "o.targets_json, o.before_json, o.status, l.lock_token_hash, l.stream_id,",
      "l.workstream_id, l.bound_request_id, l.status AS lease_status",
      "FROM resource_mutation_operations o JOIN resource_mutation_leases l ON l.lease_id = o.lease_id",
      "WHERE o.operation_id = ?",
    ].join(" ")).get(operationId) as OperationRow | undefined;
  }

  private readOperationEvents(runId: string, callId: string): ResourceEvent[] {
    const rows = this.database.prepare([
      "SELECT event_id, resource_id, workstream_id, bound_request_id, run_id, step, call_id,",
      "event_type, before_version_json, after_version_json, verification_json, summary, created_at",
      "FROM resource_events WHERE run_id = ? AND call_id = ? ORDER BY created_at, event_id",
    ].join(" ")).all(runId, callId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      eventId: String(row["event_id"]),
      resourceId: String(row["resource_id"]),
      ...(row["workstream_id"] ? { workstreamId: String(row["workstream_id"]) } : {}),
      ...(row["bound_request_id"] ? { requestId: String(row["bound_request_id"]) } : {}),
      runId: String(row["run_id"]),
      ...(row["step"] !== null ? { step: Number(row["step"]) } : {}),
      callId: String(row["call_id"]),
      type: row["event_type"] as ResourceEvent["type"],
      ...(row["before_version_json"]
        ? { beforeVersion: JSON.parse(String(row["before_version_json"])) as ResourceVersion }
        : {}),
      ...(row["after_version_json"]
        ? { afterVersion: JSON.parse(String(row["after_version_json"])) as ResourceVersion }
        : {}),
      verification: JSON.parse(String(row["verification_json"])),
      summary: String(row["summary"]),
      at: String(row["created_at"]),
    }));
  }

  private markRecoveryRequired(operationId: string, leaseId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database.transaction(() => {
      this.database.prepare([
        "UPDATE resource_mutation_operations SET status = 'recovery_required', last_error = ?",
        "WHERE operation_id = ? AND status = 'prepared'",
      ].join(" ")).run(message, operationId);
      this.database.prepare([
        "UPDATE resource_mutation_leases SET status = 'recovery_required', last_error = ?",
        "WHERE lease_id = ? AND status = 'active'",
      ].join(" ")).run(message, leaseId);
      this.database.prepare([
        "UPDATE runs SET status = 'recovery_required' WHERE run_id = (",
        "SELECT run_id FROM resource_mutation_leases WHERE lease_id = ?",
        ") AND status = 'running'",
      ].join(" ")).run(leaseId);
    });
  }

  private releaseFailedPreparation(
    operationId: string,
    leaseId: string,
    at: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const verification = {
      verified: true,
      toolStatus: "failed",
      changedPaths: [],
      unexpectedPaths: [],
      preparationFailed: true,
      toolExecuted: false,
    };
    this.database.transaction(() => {
      this.database.prepare([
        "UPDATE resource_mutation_operations SET after_json = COALESCE(after_json, 'null'),",
        "verification_json = ?, event_plan_json = '[]', tool_status = 'failed',",
        "status = 'no_change', verified_at = ?, last_error = ?",
        "WHERE operation_id = ? AND status IN ('prepared', 'recovery_required')",
      ].join(" ")).run(JSON.stringify(verification), at, message, operationId);
      this.database.prepare([
        "UPDATE resource_mutation_leases SET status = 'released', released_at = ?, last_error = ?",
        "WHERE lease_id = ? AND status IN ('active', 'recovery_required')",
      ].join(" ")).run(at, message, leaseId);
    });
  }

  private recoverSafePreExecutionFailures(at: string): void {
    const candidates = this.database.prepare([
      "SELECT o.operation_id, o.lease_id, o.run_id, o.last_error",
      "FROM resource_mutation_operations o",
      "JOIN resource_mutation_leases l ON l.lease_id = o.lease_id",
      "WHERE o.status IN ('prepared', 'recovery_required')",
      "AND l.status IN ('active', 'recovery_required')",
      "AND o.tool_status IS NULL",
      "AND NOT EXISTS (SELECT 1 FROM resource_events e",
      "  WHERE e.run_id = o.run_id AND e.call_id = o.call_id)",
    ].join(" ")).all() as unknown as Array<{
      operation_id: string;
      lease_id: string;
      run_id: string;
      last_error: string | null;
    }>;
    for (const candidate of candidates) {
      if (this.preparationCompleted(candidate.operation_id)) continue;
      this.releaseFailedPreparation(
        candidate.operation_id,
        candidate.lease_id,
        at,
        candidate.last_error ?? "Recovered an unpublished mutation preparation after interruption.",
      );
      if (!this.runHasRecoveryBlocker(candidate.run_id)) {
        this.database.prepare([
          "UPDATE runs SET status = 'running'",
          "WHERE run_id = ? AND status = 'recovery_required'",
        ].join(" ")).run(candidate.run_id);
      }
    }
  }

  private preparationCompleted(operationId: string): boolean {
    const rows = this.database.prepare([
      "SELECT response_json FROM idempotency_requests",
      "WHERE operation = 'prepare_resource_mutation' AND status = 'completed'",
    ].join(" ")).all() as unknown as Array<{ response_json: string }>;
    return rows.some((row) => {
      try {
        const response = JSON.parse(row.response_json) as { operationId?: unknown };
        return response.operationId === operationId;
      } catch {
        return true;
      }
    });
  }

  private runHasRecoveryBlocker(runId: string): boolean {
    const mutation = this.database.prepare([
      "SELECT 1 FROM resource_mutation_leases",
      "WHERE run_id = ? AND status IN ('active', 'recovery_required') LIMIT 1",
    ].join(" ")).get(runId);
    const workstreamFinalization = this.database.prepare([
      "SELECT 1 FROM workstream_finalizations",
      "WHERE run_id = ? AND phase = 'recovery_required' LIMIT 1",
    ].join(" ")).get(runId);
    const unboundFinalization = this.database.prepare([
      "SELECT 1 FROM unbound_run_finalizations",
      "WHERE run_id = ? AND phase = 'recovery_required' LIMIT 1",
    ].join(" ")).get(runId);
    const route = this.database.prepare([
      "SELECT 1 FROM workstream_request_route_plans",
      "WHERE run_id = ? AND phase = 'recovery_required' LIMIT 1",
    ].join(" ")).get(runId);
    return Boolean(mutation || workstreamFinalization || unboundFinalization || route);
  }
}

function eventType(before: ResourceVersion, after: ResourceVersion): ResourceEvent["type"] {
  if (!before.exists && after.exists) return "created";
  if (before.exists && !after.exists) return "deleted";
  return "modified";
}

function mutationSummary(type: ResourceEvent["type"], resourceId: string): string {
  if (type === "created") return "Created resource content for " + resourceId + ".";
  if (type === "deleted") return "Deleted resource content for " + resourceId + ".";
  return "Modified resource content for " + resourceId + ".";
}

function stableId(prefix: string, value: string): string {
  return prefix + "-" + createHash("sha256").update(value).digest("hex").slice(0, 24).toUpperCase();
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
