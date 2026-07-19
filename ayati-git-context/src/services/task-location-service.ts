import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  InspectTaskLocationRequest,
  InspectTaskLocationResponse,
  TaskPlacement,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { executeIdempotent, readCompletedIdempotent } from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { assertRequestedTaskNamespaceAvailable } from "../tasks/requested-task-repository-registration.js";

const MAX_BASELINE_FILES = 5_000;
const MAX_INVENTORY_ENTRIES = 10_000;
const MAX_BASELINE_BYTES = 100 * 1024 * 1024;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface ResolvedTaskPlacement {
  mode: "managed" | "requested";
  repositoryPath: string;
  trustedRoot: string;
  branch: string;
  registrationHeadBefore?: string;
  registrationWasGit: boolean;
  registrationApprovalId?: string;
  registrationSnapshotHash?: string;
  baselinePaths: string[];
  registrationExcludedPaths: string[];
}

interface RegistrationInspectionRow {
  inspection_id: string;
  session_id: string;
  conversation_id: string;
  run_id: string;
  canonical_path: string;
  trusted_root: string;
  snapshot_hash: string;
  proposed_paths_json: string;
  excluded_paths_json: string;
  status: "pending" | "consumed" | "expired";
  expires_at: string;
}

interface LocationSnapshot {
  canonicalPath: string;
  trustedRoot: string;
  kind: InspectTaskLocationResponse["kind"];
  branch?: string;
  head?: string;
  changes?: string[];
  entryCount: number;
  totalBytes: number;
  proposedPaths: string[];
  excludedPaths: string[];
  warnings: string[];
  snapshotHash: string;
}

export class TaskLocationService {
  private readonly configuredRoots: string[];

  constructor(private readonly options: {
    database: ContextDatabase;
    workspaceRoot: string;
    trustedRoots: string[];
    now: () => string;
  }) {
    this.configuredRoots = [...new Set([
      resolve(options.workspaceRoot),
      ...options.trustedRoots.map((root) => resolve(root)),
    ])];
    for (const root of this.configuredRoots) assertSafeTrustedRoot(root);
  }

  async inspect(input: InspectTaskLocationRequest): Promise<InspectTaskLocationResponse> {
    const completed = readCompletedIdempotent<InspectTaskLocationResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "inspect_task_location",
      payload: input,
    });
    if (completed) return completed;
    assertActiveRun(this.options.database, input);
    const snapshot = await this.snapshot(input.workingDirectory);
    const at = input.at;
    const needsApproval = snapshot.kind === "non_git_directory";
    const inspectionId = needsApproval
      ? "I-" + createHash("sha256").update(input.requestId).digest("hex").slice(0, 24)
      : undefined;
    const expiresAt = inspectionId
      ? new Date(Date.parse(at) + APPROVAL_TTL_MS).toISOString()
      : undefined;
    const response: InspectTaskLocationResponse = {
      canonicalPath: snapshot.canonicalPath,
      kind: snapshot.kind,
      trustedRoot: snapshot.trustedRoot,
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      ...(snapshot.head ? { head: snapshot.head } : {}),
      ...(snapshot.changes ? { changes: snapshot.changes } : {}),
      entryCount: snapshot.entryCount,
      totalBytes: snapshot.totalBytes,
      proposedPaths: snapshot.proposedPaths,
      excludedPaths: snapshot.excludedPaths,
      warnings: snapshot.warnings,
      ...(inspectionId ? { registrationApprovalId: inspectionId } : {}),
      ...(expiresAt ? { approvalExpiresAt: expiresAt } : {}),
    };
    return executeIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      operation: "inspect_task_location",
      payload: input,
      now: at,
      execute: () => {
        if (inspectionId && expiresAt) {
          this.options.database.prepare([
            "INSERT INTO task_registration_inspections(",
            "inspection_id, request_id, session_id, conversation_id, run_id, canonical_path,",
            "trusted_root, snapshot_hash, proposed_paths_json, excluded_paths_json,",
            "entry_count, total_bytes, status, created_at, expires_at)",
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
          ].join(" ")).run(
            inspectionId,
            input.requestId,
            input.sessionId,
            input.conversationId,
            input.runId,
            snapshot.canonicalPath,
            snapshot.trustedRoot,
            snapshot.snapshotHash,
            JSON.stringify(snapshot.proposedPaths),
            JSON.stringify(snapshot.excludedPaths),
            snapshot.entryCount,
            snapshot.totalBytes,
            at,
            expiresAt,
          );
        }
        return response;
      },
    });
  }

  async resolvePlacement(input: {
    placement: TaskPlacement;
    sessionId: string;
    runId: string;
    at: string;
    managedRepositoryPath: string;
    taskRoot: string;
  }): Promise<ResolvedTaskPlacement> {
    if (input.placement.mode === "managed") {
      return {
        mode: "managed",
        repositoryPath: input.managedRepositoryPath,
        trustedRoot: resolve(input.taskRoot),
        branch: "main",
        registrationWasGit: false,
        baselinePaths: [],
        registrationExcludedPaths: [],
      };
    }
    const snapshot = await this.snapshot(input.placement.workingDirectory);
    if (snapshot.kind === "dirty_git_repository") {
      throw new GitContextServiceError({
        code: "TASK_REPOSITORY_DIRTY",
        message: "Existing Git repositories must be clean before task registration.",
        details: { repositoryPath: snapshot.canonicalPath, changes: snapshot.changes ?? [] },
      });
    }
    if (snapshot.kind === "clean_git_repository") {
      return {
        mode: "requested",
        repositoryPath: snapshot.canonicalPath,
        trustedRoot: snapshot.trustedRoot,
        branch: snapshot.branch ?? "main",
        registrationWasGit: true,
        ...(snapshot.head ? { registrationHeadBefore: snapshot.head } : {}),
        baselinePaths: [],
        registrationExcludedPaths: [],
      };
    }
    if (snapshot.kind === "empty_directory") {
      return {
        mode: "requested",
        repositoryPath: snapshot.canonicalPath,
        trustedRoot: snapshot.trustedRoot,
        branch: "main",
        registrationWasGit: false,
        baselinePaths: [],
        registrationExcludedPaths: [],
      };
    }
    const approvalId = input.placement.registrationApprovalId;
    if (!approvalId) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "A non-empty non-Git directory requires an explicit registration approval receipt.",
        details: { repositoryPath: snapshot.canonicalPath },
      });
    }
    const approval = readInspection(this.options.database, approvalId);
    validateApproval({
      database: this.options.database,
      approval,
      approvalId,
      sessionId: input.sessionId,
      currentRunId: input.runId,
      at: input.at,
      snapshot,
    });
    return {
      mode: "requested",
      repositoryPath: snapshot.canonicalPath,
      trustedRoot: snapshot.trustedRoot,
      branch: "main",
      registrationWasGit: false,
      registrationApprovalId: approvalId,
      registrationSnapshotHash: snapshot.snapshotHash,
      baselinePaths: snapshot.proposedPaths,
      registrationExcludedPaths: snapshot.excludedPaths,
    };
  }

  private async snapshot(workingDirectory: string): Promise<LocationSnapshot> {
    const requested = isAbsolute(workingDirectory)
      ? resolve(workingDirectory)
      : resolve(this.options.workspaceRoot, workingDirectory);
    const targetState = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new GitContextServiceError({
          code: "TASK_REPOSITORY_INVALID",
          message: "Requested task directory does not exist.",
          details: { workingDirectory: requested },
        });
      }
      throw error;
    });
    if (targetState.isSymbolicLink() || !targetState.isDirectory()) {
      throw new GitContextServiceError({
        code: "TASK_REPOSITORY_INVALID",
        message: "Requested task location must be a normal directory.",
        details: { workingDirectory: requested },
      });
    }
    const canonicalPath = await realpath(requested);
    const trustedRoot = await this.trustedRoot(canonicalPath);
    assertNoCatalogOverlap(this.options.database, canonicalPath);
    await assertRequestedTaskNamespaceAvailable(this.options.workspaceRoot, canonicalPath);
    const entries = await readdir(canonicalPath);
    if (entries.length === 0) {
      return {
        canonicalPath,
        trustedRoot,
        kind: "empty_directory",
        entryCount: 0,
        totalBytes: 0,
        proposedPaths: [],
        excludedPaths: [],
        warnings: [],
        snapshotHash: hashSnapshot([]),
      };
    }
    const git = await inspectGit(canonicalPath);
    if (git) {
      return {
        canonicalPath,
        trustedRoot,
        kind: git.changes.length > 0 ? "dirty_git_repository" : "clean_git_repository",
        branch: git.branch,
        ...(git.head ? { head: git.head } : {}),
        changes: git.changes,
        entryCount: entries.length,
        totalBytes: 0,
        proposedPaths: [],
        excludedPaths: [],
        warnings: git.changes.length > 0
          ? ["Commit or otherwise reconcile existing Git changes before registration."]
          : [],
        snapshotHash: hashSnapshot([git.head ?? "unborn", ...git.changes]),
      };
    }
    const inventory = await inventoryDirectory(canonicalPath);
    return {
      canonicalPath,
      trustedRoot,
      kind: "non_git_directory",
      ...inventory,
    };
  }

  private async trustedRoot(canonicalPath: string): Promise<string> {
    const available: string[] = [];
    for (const configured of this.configuredRoots) {
      const root = await realpath(configured).catch(() => undefined);
      if (!root) continue;
      assertSafeTrustedRoot(root);
      if (root !== canonicalPath && isWithin(root, canonicalPath)) available.push(root);
    }
    available.sort((left, right) => right.length - left.length);
    const selected = available[0];
    if (!selected) {
      throw new GitContextServiceError({
        code: "TASK_REPOSITORY_INVALID",
        message: "Requested task directory is outside configured trusted roots.",
        details: { repositoryPath: canonicalPath, trustedRoots: this.configuredRoots },
      });
    }
    return selected;
  }
}

export function consumeRegistrationApproval(input: {
  database: ContextDatabase;
  approvalId: string;
  at: string;
}): void {
  const result = input.database.prepare([
    "UPDATE task_registration_inspections SET status = 'consumed', consumed_at = ?",
    "WHERE inspection_id = ? AND status = 'pending'",
  ].join(" ")).run(input.at, input.approvalId);
  if (Number(result.changes) !== 1) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Task registration approval is no longer available.",
      details: { registrationApprovalId: input.approvalId },
    });
  }
}

async function inspectGit(repositoryPath: string): Promise<{
  branch: string;
  head?: string;
  changes: string[];
} | undefined> {
  let topLevel: string;
  try {
    topLevel = resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: repositoryPath }));
  } catch {
    return undefined;
  }
  if (topLevel !== resolve(repositoryPath)) {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task directory must be the exact Git repository root.",
      details: { repositoryPath, gitRoot: topLevel },
    });
  }
  if (await runGit(["rev-parse", "--is-bare-repository"], { cwd: repositoryPath }) !== "false") {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task repository must be non-bare.",
      details: { repositoryPath },
    });
  }
  let branch: string;
  try {
    branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repositoryPath });
  } catch {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task repository must have an attached branch.",
      details: { repositoryPath },
    });
  }
  const head = await runGit(["rev-parse", "HEAD"], { cwd: repositoryPath })
    .catch(() => undefined);
  const status = await runGitRaw(["status", "--porcelain", "--untracked-files=all"], {
    cwd: repositoryPath,
  });
  return {
    branch,
    ...(head ? { head } : {}),
    changes: status.replaceAll("\r\n", "\n").trimEnd().split("\n").filter(Boolean),
  };
}

async function inventoryDirectory(repositoryPath: string): Promise<Omit<
  LocationSnapshot,
  "canonicalPath" | "trustedRoot" | "kind"
>> {
  const proposedPaths: string[] = [];
  const excludedPaths: string[] = [];
  const warnings: string[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const digest = createHash("sha256");
  const visit = async (relativePath: string): Promise<void> => {
    const directory = resolve(repositoryPath, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = relativePath ? relativePath + "/" + entry.name : entry.name;
      entryCount++;
      if (entryCount > MAX_INVENTORY_ENTRIES || /[\0\r\n]/.test(path)) {
        throw new GitContextServiceError({
          code: "INVALID_REQUEST",
          message: "Existing directory contains too many entries or an unsupported filename.",
          details: { repositoryPath, maximumEntries: MAX_INVENTORY_ENTRIES },
        });
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          excludedPaths.push(path + "/");
          continue;
        }
        await visit(path);
        continue;
      }
      if (!entry.isFile() || isSensitivePath(path)) {
        excludedPaths.push(path);
        warnings.push(`Excluded unsafe or unsupported path: ${path}`);
        continue;
      }
      const metadata = await stat(resolve(repositoryPath, path));
      totalBytes += metadata.size;
      if (proposedPaths.length >= MAX_BASELINE_FILES || totalBytes > MAX_BASELINE_BYTES) {
        throw new GitContextServiceError({
          code: "INVALID_REQUEST",
          message: "Existing directory exceeds the automatic baseline safety limit.",
          details: {
            repositoryPath,
            maximumFiles: MAX_BASELINE_FILES,
            maximumBytes: MAX_BASELINE_BYTES,
          },
        });
      }
      const bytes = await readFile(resolve(repositoryPath, path));
      digest.update(path).update("\0").update(String(metadata.size)).update("\0").update(bytes);
      proposedPaths.push(path);
    }
  };
  await visit("");
  return {
    entryCount,
    totalBytes,
    proposedPaths,
    excludedPaths,
    warnings: [...new Set(warnings)],
    snapshotHash: "sha256:" + digest.digest("hex"),
  };
}

function validateApproval(input: {
  database: ContextDatabase;
  approval: RegistrationInspectionRow | undefined;
  approvalId: string;
  sessionId: string;
  currentRunId: string;
  at: string;
  snapshot: LocationSnapshot;
}): void {
  const approval = input.approval;
  const priorRun = approval ? readRunEvidence(input.database, approval.run_id) : undefined;
  const currentRun = readRunEvidence(input.database, input.currentRunId);
  const sequences = approval ? input.database.prepare([
    "SELECT run_id, run_sequence FROM runs WHERE run_id IN (?, ?)",
  ].join(" ")).all(approval.run_id, input.currentRunId) as unknown as Array<{
    run_id: string;
    run_sequence: number;
  }> : [];
  const priorSequence = sequences.find((run) => run.run_id === approval?.run_id)?.run_sequence;
  const currentSequence = sequences.find((run) => run.run_id === input.currentRunId)?.run_sequence;
  const proposed = approval ? parseStringArray(approval.proposed_paths_json) : [];
  const excluded = approval ? parseStringArray(approval.excluded_paths_json) : [];
  const matches = approval
    && approval.status === "pending"
    && approval.session_id === input.sessionId
    && Date.parse(approval.expires_at) >= Date.parse(input.at)
    && approval.canonical_path === input.snapshot.canonicalPath
    && approval.trusted_root === input.snapshot.trustedRoot
    && approval.snapshot_hash === input.snapshot.snapshotHash
    && JSON.stringify(proposed) === JSON.stringify(input.snapshot.proposedPaths)
    && JSON.stringify(excluded) === JSON.stringify(input.snapshot.excludedPaths)
    && priorRun?.status === "needs_user_input"
    && currentSequence === Number(priorSequence) + 1
    && currentRun?.status === "running"
    && currentRun.sessionId === input.sessionId;
  if (!matches) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "Task registration approval is expired, changed, or not tied to the preceding confirmation flow.",
      details: { registrationApprovalId: input.approvalId },
    });
  }
}

function assertActiveRun(
  database: ContextDatabase,
  input: Pick<InspectTaskLocationRequest, "sessionId" | "conversationId" | "runId">,
): void {
  const run = readRunEvidence(database, input.runId);
  if (!run || run.status !== "running" || run.sessionId !== input.sessionId
    || run.conversationId !== input.conversationId || run.taskBinding) {
    throw new GitContextServiceError({
      code: "RUN_NOT_ACTIVE",
      message: "Task location inspection requires the matching active unbound run.",
      details: input,
    });
  }
}

function assertNoCatalogOverlap(database: ContextDatabase, path: string): void {
  const rows = database.prepare("SELECT task_id, repository_path FROM tasks").all() as unknown as Array<{
    task_id: string;
    repository_path: string;
  }>;
  const conflict = rows.find((row) => isWithin(resolve(row.repository_path), path)
    || isWithin(path, resolve(row.repository_path)));
  if (conflict) {
    throw new GitContextServiceError({
      code: "TASK_REPOSITORY_INVALID",
      message: "Requested task directory overlaps an existing task repository.",
      details: { repositoryPath: path, existingTaskId: conflict.task_id },
    });
  }
}

function assertSafeTrustedRoot(path: string): void {
  const resolved = resolve(path);
  if (resolved === resolve(sep) || resolved === resolve(homedir())) {
    throw new GitContextServiceError({
      code: "INVALID_REQUEST",
      message: "A broad filesystem or home root cannot be configured as a task trusted root.",
      details: { trustedRoot: resolved },
    });
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  return (name === ".env" || (name.startsWith(".env.") && name !== ".env.example"))
    || /(?:^|[-_.])(credentials?|secrets?|private[-_]?key)(?:[-_.]|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function readInspection(
  database: ContextDatabase,
  inspectionId: string,
): RegistrationInspectionRow | undefined {
  return database.prepare([
    "SELECT inspection_id, session_id, conversation_id, run_id, canonical_path,",
    "trusted_root, snapshot_hash, proposed_paths_json, excluded_paths_json, status, expires_at",
    "FROM task_registration_inspections WHERE inspection_id = ?",
  ].join(" ")).get(inspectionId) as RegistrationInspectionRow | undefined;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ? parsed
    : [];
}

function hashSnapshot(values: string[]): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
