import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  PrepareResourceMutationRequest,
  PrepareResourceMutationResponse,
  ResourceEvent,
  ResourceMutationTarget,
  ResourceRef,
  ResourceVersion,
  VerifyResourceMutationRequest,
  VerifyResourceMutationResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import {
  readResource,
  recordResourceObservation,
} from "../repositories/resource-records.js";

const LEASE_DURATION_MS = 15 * 60 * 1_000;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

interface ResolvedTarget extends ResourceMutationTarget {
  resolvedPath: string;
  rootPath: string;
}

interface SnapshotEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
  sha256?: string;
}

interface ResourceSnapshot {
  resourceId: string;
  rootPath: string;
  entries: SnapshotEntry[];
  version: ResourceVersion;
}

interface OperationSnapshot {
  targets: ResolvedTarget[];
  resources: ResourceSnapshot[];
}

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
  session_id: string;
  workstream_id: string;
  bound_request_id: string;
  lease_status: "active" | "recovery_required" | "released";
}

export class ResourceMutationService {
  constructor(
    private readonly database: ContextDatabase,
  ) {}

  async prepare(
    input: PrepareResourceMutationRequest,
    onAuthorityPrepared?: (response: PrepareResourceMutationResponse) => void,
  ): Promise<PrepareResourceMutationResponse> {
    const resources = this.requireMutationResources(input);
    const targets = await resolveTargets(resources, input.targets);
    const leaseId = stableId("RL", input.runId + "\u0000" + input.callId);
    const operationId = stableId("RM", input.runId + "\u0000" + input.callId);
    const lockToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.parse(input.at) + LEASE_DURATION_MS).toISOString();

    this.database.transaction(() => {
      this.assertScopesAvailable(targets);
      this.database.prepare([
        "INSERT INTO resource_mutation_leases(",
        "lease_id, session_id, run_id, workstream_id, bound_request_id, lock_token_hash, status,",
        "acquired_at, expires_at, released_at, last_error",
        ") VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)",
      ].join(" ")).run(
        leaseId,
        input.sessionId,
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
      onAuthorityPrepared?.(response);
      const snapshot = await snapshotOperation(targets, input.at);
      this.database.transaction(() => {
        const result = this.database.prepare([
          "UPDATE resource_mutation_operations SET before_json = ?",
          "WHERE operation_id = ? AND status = 'prepared'",
        ].join(" ")).run(JSON.stringify(snapshot), operationId);
        if (Number(result.changes) !== 1) throw new Error("Mutation operation disappeared while preparing.");
      });
    } catch (error) {
      this.markRecoveryRequired(operationId, leaseId, error);
      throw error;
    }

    return response;
  }

  operationContext(operationId: string): {
    sessionId: string;
    runId: string;
    workstreamId: string;
    operationStatus: OperationRow["status"];
    leaseStatus: OperationRow["lease_status"];
  } | undefined {
    const operation = this.readOperation(operationId);
    return operation
      ? {
          sessionId: operation.session_id,
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
      throw new GitContextServiceError({
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
      throw new GitContextServiceError({
        code: "MUTATION_LOCK_INVALID",
        message: "Resource mutation capability token is invalid.",
      });
    }
    const before = parseSnapshot(operation.before_json);
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

    let after: OperationSnapshot;
    try {
      after = await snapshotOperation(before.targets, input.at);
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
    const comparison = compareSnapshots(before, after);
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
                (path) => isWithin(afterResource.rootPath, path),
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

  recoverInterrupted(): string[] {
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
      "SELECT session_id, workstream_id, bound_request_id, status FROM runs WHERE run_id = ?",
    ].join(" ")).get(input.runId) as {
      session_id: string;
      workstream_id: string | null;
      bound_request_id: string | null;
      status: string;
    } | undefined;
    if (!run || run.status !== "running" || run.session_id !== input.sessionId
      || run.workstream_id !== input.workstreamId || run.bound_request_id !== input.activeRequestId) {
      throw new GitContextServiceError({
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
        throw new GitContextServiceError({
          code: "RESOURCE_MUTATION_UNAVAILABLE",
          message: "Mutation target is not a mutable resource bound to this workstream.",
          details: { resourceId: target.resourceId },
        });
      }
      if (target.expectedVersionKey && target.expectedVersionKey !== resource.version.key) {
        throw new GitContextServiceError({
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

  private assertScopesAvailable(targets: ResolvedTarget[]): void {
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
      && pathsOverlap(lock.canonical_scope, target.resolvedPath)));
    if (conflict) {
      throw new GitContextServiceError({
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
      "o.targets_json, o.before_json, o.status, l.lock_token_hash, l.session_id,",
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
}

async function resolveTargets(
  resources: ReadonlyMap<string, ResourceRef>,
  targets: ResourceMutationTarget[],
): Promise<ResolvedTarget[]> {
  const resolved: ResolvedTarget[] = [];
  const scopes = new Set<string>();
  for (const target of targets) {
    const resource = resources.get(target.resourceId);
    if (!resource || resource.locator.kind !== "filesystem") throw new Error("Missing resource target.");
    const rootPath = resolve(resource.locator.path);
    let resolvedPath = rootPath;
    if (target.relativePath) {
      if (resource.kind !== "directory" && resource.kind !== "git_repository") {
        throw invalidTarget(target, "Relative mutation targets require a directory resource.");
      }
      const portable = target.relativePath.replaceAll("\\", "/");
      if (isAbsolute(portable) || portable.split("/").some((part) => part === ".." || part === ".")) {
        throw invalidTarget(target, "Relative mutation target is not a safe portable path.");
      }
      resolvedPath = resolve(rootPath, portable);
      if (!isWithin(rootPath, resolvedPath)) {
        throw invalidTarget(target, "Relative mutation target escapes its resource root.");
      }
    }
    await assertNoSymlinkTraversal(rootPath, resolvedPath);
    const state = await lstat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (state?.isSymbolicLink()) throw invalidTarget(target, "Mutation target may not be a symbolic link.");
    if (state && ((target.kind === "file" && !state.isFile())
      || (target.kind === "directory" && !state.isDirectory()))) {
      throw invalidTarget(target, "Mutation target kind does not match the filesystem.");
    }
    const identity = target.resourceId + "\u0000" + resolvedPath;
    if (scopes.has(identity)) continue;
    scopes.add(identity);
    resolved.push({ ...target, resolvedPath, rootPath });
  }
  return resolved.sort((left, right) => left.resourceId.localeCompare(right.resourceId)
    || left.resolvedPath.localeCompare(right.resolvedPath));
}

async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  let current = root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    const state = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!state) break;
    if (state.isSymbolicLink()) {
      throw new GitContextServiceError({
        code: "MUTATION_TARGET_INVALID",
        message: "Mutation target traverses a symbolic link.",
        details: { path: current },
      });
    }
  }
}

async function snapshotOperation(targets: ResolvedTarget[], at: string): Promise<OperationSnapshot> {
  const resources: ResourceSnapshot[] = [];
  for (const target of targets) {
    if (resources.some((resource) => resource.resourceId === target.resourceId)) continue;
    resources.push(await snapshotResource(target.resourceId, target.rootPath, at));
  }
  return { targets, resources };
}

async function snapshotResource(
  resourceId: string,
  rootPath: string,
  at: string,
): Promise<ResourceSnapshot> {
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  const rootState = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootState?.isSymbolicLink()) {
    throw new GitContextServiceError({
      code: "RESOURCE_VERIFICATION_UNAVAILABLE",
      message: "Resource root became a symbolic link.",
      details: { resourceId, rootPath },
    });
  }
  async function visit(path: string): Promise<void> {
    if (entries.length >= MAX_SNAPSHOT_ENTRIES) verificationLimit(resourceId, "entry count");
    const state = await lstat(path);
    const itemPath = relative(rootPath, path).replaceAll("\\", "/") || ".";
    if (state.isSymbolicLink()) {
      throw new GitContextServiceError({
        code: "RESOURCE_VERIFICATION_UNAVAILABLE",
        message: "Resource snapshot contains a symbolic link.",
        details: { resourceId, path },
      });
    }
    if (state.isFile()) {
      totalBytes += state.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) verificationLimit(resourceId, "byte count");
      entries.push({ path: itemPath, kind: "file", size: state.size, sha256: await hashFile(path) });
      return;
    }
    if (!state.isDirectory()) {
      throw new GitContextServiceError({
        code: "RESOURCE_VERIFICATION_UNAVAILABLE",
        message: "Resource snapshot contains a non-file entry.",
        details: { resourceId, path },
      });
    }
    entries.push({ path: itemPath, kind: "directory", size: 0 });
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (itemPath === "." && child.name === ".git") continue;
      await visit(join(path, child.name));
    }
  }
  if (rootState) await visit(rootPath);
  const fingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const version: ResourceVersion = rootState
    ? rootState.isFile()
      ? {
          key: "file:sha256:" + (entries[0]?.sha256 ?? fingerprint),
          observedAt: at,
          exists: true,
          kind: "file",
          sha256: entries[0]?.sha256 ?? fingerprint,
          sizeBytes: rootState.size,
          modifiedAt: rootState.mtime.toISOString(),
        }
      : {
          key: "directory:" + fingerprint,
          observedAt: at,
          exists: true,
          kind: "directory",
          fingerprint,
          entryCount: entries.length,
          sizeBytes: totalBytes,
        }
    : {
        key: "missing:" + createHash("sha256").update(rootPath).digest("hex"),
        observedAt: at,
        exists: false,
        kind: "unversioned",
      };
  return { resourceId, rootPath, entries, version };
}

function compareSnapshots(before: OperationSnapshot, after: OperationSnapshot): {
  changedPaths: string[];
  unexpectedPaths: string[];
} {
  const changedPaths = new Set<string>();
  for (const beforeResource of before.resources) {
    const afterResource = after.resources.find((item) => item.resourceId === beforeResource.resourceId);
    if (!afterResource) continue;
    const beforeEntries = new Map(beforeResource.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    const afterEntries = new Map(afterResource.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
    for (const path of new Set([...beforeEntries.keys(), ...afterEntries.keys()])) {
      if (beforeEntries.get(path) !== afterEntries.get(path)) {
        changedPaths.add(resolve(beforeResource.rootPath, path === "." ? "" : path));
      }
    }
  }
  const ordered = [...changedPaths].sort();
  const unexpectedPaths = ordered.filter((path) => !before.targets.some((target) => {
    if (target.kind === "directory") return isWithin(target.resolvedPath, path);
    return resolve(target.resolvedPath) === resolve(path);
  }));
  return { changedPaths: ordered, unexpectedPaths };
}

function parseSnapshot(value: string): OperationSnapshot | undefined {
  if (value === "null") return undefined;
  return JSON.parse(value) as OperationSnapshot;
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

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function invalidTarget(target: ResourceMutationTarget, message: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "MUTATION_TARGET_INVALID",
    message,
    details: { resourceId: target.resourceId, relativePath: target.relativePath ?? null },
  });
}

function verificationLimit(resourceId: string, limit: string): never {
  throw new GitContextServiceError({
    code: "RESOURCE_VERIFICATION_UNAVAILABLE",
    message: "Resource is too large for deterministic mutation verification.",
    details: { resourceId, limit },
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}
