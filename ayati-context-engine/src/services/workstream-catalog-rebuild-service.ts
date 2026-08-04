import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { runGitRaw } from "../git/git-process.js";
import {
  insertWorkstreamProgressProjection,
} from "../repositories/workstream-progress-records.js";
import {
  initializeSharedWorkstreamRepositoryState,
} from "../repositories/workstream-repository-state-records.js";
import {
  resourceLocatorKey,
} from "../repositories/resource-records.js";
import {
  writeWorkstreamDiscoveryProjection,
} from "../repositories/workstream-discovery-records.js";
import {
  synchronizeCurrentWorkstreamRequest,
  writeWorkstreamRequestProjection,
} from "../repositories/workstream-request-records.js";
import { WORKSTREAM_CARD_PATH } from "../workstreams/workstream-repository-layout.js";
import { parseWorkstreamCommit } from "../workstreams/workstream-commit-metadata.js";
import type { WorkstreamProgressEntry } from "../workstreams/workstream-progress.js";
import type { WorkstreamResourceManifestEntry } from "../workstreams/workstream-resource-manifest.js";
import type { WorkstreamRequest } from "../workstreams/workstream-request.js";
import {
  validateWorkstreamRepository,
  type WorkstreamRepositoryHealth,
} from "../workstreams/workstream-repository-validator.js";

export interface WorkstreamCatalogRebuildRepository {
  workstreamId: string;
  contextRepositoryPath: string;
  repositoryPath: string;
  branch: "main";
  head: string;
  repositoryHead: string;
  title: string;
  objective: string;
  aliases: string[];
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: WorkstreamRepositoryHealth;
  currentSnapshot: string;
  currentFocus: string;
  importantFindings: string[];
  blockers: string[];
  currentRequest?: WorkstreamRequest;
  requests: WorkstreamRequest[];
  progress: WorkstreamProgressEntry[];
  progressCommits: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  resources: WorkstreamResourceManifestEntry[];
}

export interface WorkstreamCatalogRebuildFailure {
  contextRepositoryPath: string;
  message: string;
}

export interface WorkstreamCatalogRebuildResult {
  scannedDirectories: number;
  repositories: WorkstreamCatalogRebuildRepository[];
  failures: WorkstreamCatalogRebuildFailure[];
  applied: boolean;
}

export async function rebuildWorkstreamCatalog(input: {
  workstreamRoot: string;
  now: string;
  database?: ContextDatabase;
  confirm: boolean;
}): Promise<WorkstreamCatalogRebuildResult> {
  const workstreamRoot = await realpath(resolve(input.workstreamRoot)).catch(() => undefined);
  const candidates = workstreamRoot ? await directWorkstreamDirectories(workstreamRoot) : [];
  const repositories: WorkstreamCatalogRebuildRepository[] = [];
  const failures: WorkstreamCatalogRebuildFailure[] = [];
  for (const candidate of candidates) {
    try {
      const validation = await validateWorkstreamRepository({
        workstreamRoot: workstreamRoot!,
        contextRepositoryPath: candidate,
        requestReadMode: "all",
      });
      const history = await pathCommitHistory(
        validation.repositoryPath,
        basename(candidate),
        input.now,
      );
      validateProgressRequests(
        validation.progress.entries,
        validation.requests,
      );
      repositories.push({
        workstreamId: validation.workstreamId,
        contextRepositoryPath: validation.contextRepositoryPath,
        repositoryPath: validation.repositoryPath,
        branch: "main",
        head: validation.head,
        repositoryHead: validation.repositoryHead,
        title: validation.workstreamCard.title,
        objective: validation.workstreamCard.purpose,
        aliases: [...validation.workstreamCard.aliases],
        lifecycleStatus: validation.workstreamCard.status,
        repositoryHealth: validation.health,
        currentSnapshot: validation.workstreamCard.currentSnapshot,
        currentFocus: validation.workstreamCard.currentFocus,
        importantFindings: [...validation.workstreamCard.importantFindings],
        blockers: [...validation.workstreamCard.blockers],
        ...(validation.currentRequest
          ? { currentRequest: structuredClone(validation.currentRequest) }
          : {}),
        requests: validation.requests.map((request) => structuredClone(request)),
        progress: validation.progress.entries.map((entry) => structuredClone(entry)),
        createdAt: history.createdAt,
        updatedAt: history.updatedAt,
        progressCommits: history.progressCommits,
        resources: validation.resourceManifest.resources.map((entry) => structuredClone(entry)),
      });
    } catch (error) {
      failures.push({
        contextRepositoryPath: candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  repositories.sort((left, right) => left.workstreamId.localeCompare(right.workstreamId));
  failures.push(...catalogFailures(repositories));
  failures.sort((left, right) => left.contextRepositoryPath.localeCompare(
    right.contextRepositoryPath,
  ) || left.message.localeCompare(right.message));
  if (!input.confirm) {
    return {
      scannedDirectories: candidates.length,
      repositories,
      failures,
      applied: false,
    };
  }
  if (!input.database) {
    throw new Error("Catalog rebuild confirmation requires an initialized V12 database.");
  }
  if (failures.length > 0) {
    throw new Error("Catalog rebuild refused because shared-repository validation failed.");
  }
  applyCatalog(input.database, repositories, input.now);
  return {
    scannedDirectories: candidates.length,
    repositories,
    failures,
    applied: true,
  };
}

async function directWorkstreamDirectories(workstreamRoot: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(workstreamRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("W-")) continue;
    const candidate = join(workstreamRoot, entry.name);
    const card = await lstat(join(candidate, WORKSTREAM_CARD_PATH)).catch(() => undefined);
    if (card?.isFile() && !card.isSymbolicLink()) result.push(await realpath(candidate));
  }
  return result;
}

function applyCatalog(
  database: ContextDatabase,
  repositories: WorkstreamCatalogRebuildRepository[],
  now: string,
): void {
  const counts = database.prepare([
    "SELECT",
    "(SELECT COUNT(*) FROM workstreams) AS workstreams,",
    "(SELECT COUNT(*) FROM workstream_requests) AS requests,",
    "(SELECT COUNT(*) FROM workstream_progress) AS progress,",
    "(SELECT COUNT(*) FROM resources) AS resources,",
    "(SELECT COUNT(*) FROM workstream_repository_state) AS repository_state",
  ].join(" ")).get() as Record<string, number>;
  if (Object.values(counts).some((count) => Number(count) !== 0)) {
    throw new Error("Catalog rebuild requires an empty workstream, request, progress, and resource catalog.");
  }
  const repository = requireOneSharedRepository(repositories);
  database.transaction(() => {
    if (repository) {
      initializeSharedWorkstreamRepositoryState(database, {
        repositoryPath: repository.repositoryPath,
        branch: "main",
        head: repository.repositoryHead,
        health: repository.repositoryHealth,
        updatedAt: now,
      });
    }
    for (const workstream of repositories) insertWorkstream(database, workstream);
    for (const workstream of repositories) {
      for (const request of workstream.requests) {
        writeWorkstreamRequestProjection(database, {
          request,
          lastActivityAt: request.updatedAt,
        });
      }
      synchronizeCurrentWorkstreamRequest(database, workstream.workstreamId);
    }
    for (const item of rebuildResources(repositories)) insertResource(database, item);
    for (const workstream of repositories) insertResourceBindings(database, workstream);
    for (const workstream of repositories) {
      for (const entry of workstream.progress) {
        insertWorkstreamProgressProjection(database, {
          workstreamId: workstream.workstreamId,
          entry,
          commit: commitForProgress(workstream, entry),
        });
      }
      writeWorkstreamDiscoveryProjection(database, {
        workstreamId: workstream.workstreamId,
        expectedHead: workstream.head,
        title: workstream.title,
        objective: workstream.objective,
        aliases: workstream.aliases,
        currentSnapshot: workstream.currentSnapshot,
        currentFocus: workstream.currentFocus,
        importantFindings: workstream.importantFindings,
        lifecycleStatus: workstream.lifecycleStatus,
        repositoryHealth: workstream.repositoryHealth,
        ...(workstream.currentRequest ? {
          currentRequest: {
            id: workstream.currentRequest.id,
            title: workstream.currentRequest.title,
            status: workstream.currentRequest.status,
            searchText: [
              workstream.currentRequest.title,
              workstream.currentRequest.request,
            ].join("\n"),
          },
        } : {}),
      });
    }
  });
}

function insertWorkstream(
  database: ContextDatabase,
  workstream: WorkstreamCatalogRebuildRepository,
): void {
  database.prepare([
    "INSERT INTO workstreams(",
    "workstream_id, directory_path, title, aliases_json, purpose, initial_request_json,",
    "lifecycle_status, current_request_id, current_snapshot, current_focus, blockers_json,",
    "last_run_id, last_commit_sha, last_activity_at, status, created_by_run_id, created_at, updated_at",
    ") VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)",
  ].join(" ")).run(
    workstream.workstreamId,
    workstream.contextRepositoryPath,
    workstream.title,
    JSON.stringify(workstream.aliases),
    workstream.objective,
    workstream.lifecycleStatus,
    workstream.currentSnapshot,
    workstream.currentFocus,
    JSON.stringify(workstream.blockers),
    workstream.head,
    workstream.updatedAt,
    workstream.lifecycleStatus === "archived" ? "archived" : "active",
    workstream.createdAt,
    workstream.updatedAt,
  );
}

interface RebuildResource {
  entry: WorkstreamResourceManifestEntry;
  createdAt: string;
  updatedAt: string;
}

function insertResource(database: ContextDatabase, item: RebuildResource): void {
  const resource = item.entry;
  const locatorKey = resourceLocatorKey(resource.locator);
  const metadataStatus = resource.metadataStatus ?? "enriched";
  const describedVersionKey = resource.describedVersionKey
    ?? (metadataStatus === "enriched" ? resource.version.key : null);
  database.prepare([
    "INSERT INTO resources(",
    "resource_id, kind, origin, locator_kind, locator_key, locator_json, display_name,",
    "description, aliases_json, metadata_status, described_version_key, media_type, size_bytes,",
    "content_hash, current_version_key, current_version_json, availability, metadata_json,",
    "created_by_run_id, last_verified_run_id, last_verified_at, created_at, updated_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,",
    "NULL, NULL, NULL, ?, ?)",
  ].join(" ")).run(
    resource.resourceId,
    resource.kind,
    resource.origin,
    resource.locator.kind,
    locatorKey,
    JSON.stringify(resource.locator),
    resource.displayName,
    resource.description,
    JSON.stringify(resource.aliases),
    metadataStatus,
    describedVersionKey,
    resource.mediaType ?? null,
    resource.version.sizeBytes ?? null,
    resource.version.sha256 ?? null,
    resource.version.key,
    JSON.stringify(resource.version),
    resource.availability,
    JSON.stringify({
      ...(resource.formerLocators
        ? { formerLocators: resource.formerLocators }
        : {}),
    }),
    item.createdAt,
    item.updatedAt,
  );
  database.prepare([
    "INSERT INTO resource_search(resource_id, display_name, description, aliases, locator_text)",
    "VALUES (?, ?, ?, ?, ?)",
  ].join(" ")).run(
    resource.resourceId,
    resource.displayName,
    resource.description,
    resource.aliases.join("\n"),
    [
      locatorKey,
      ...(resource.formerLocators ?? []).map(resourceLocatorKey),
    ].join(" "),
  );
}

function insertResourceBindings(
  database: ContextDatabase,
  workstream: WorkstreamCatalogRebuildRepository,
): void {
  const requestIds = new Set(workstream.requests.map((request) => request.id));
  for (const resource of workstream.resources) {
    const usedAt = resource.lastUsedAt ?? workstream.updatedAt;
    database.prepare([
      "INSERT INTO workstream_resources(",
      "workstream_id, resource_id, role, access, is_primary, first_bound_run_id,",
      "last_used_run_id, bound_at, last_used_at",
      ") VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
    ].join(" ")).run(
      workstream.workstreamId,
      resource.resourceId,
      resource.role,
      resource.access,
      resource.primary ? 1 : 0,
      workstream.createdAt,
      usedAt,
    );
    for (const requestId of resource.requestIds) {
      if (!requestIds.has(requestId)) {
        throw new Error("Resource manifest references an unknown request: " + requestId);
      }
      database.prepare([
        "INSERT INTO request_resources(",
        "workstream_id, request_id, resource_id, role, created_by_run_id, created_at",
        ") VALUES (?, ?, ?, ?, NULL, ?)",
      ].join(" ")).run(
        workstream.workstreamId,
        requestId,
        resource.resourceId,
        resource.role,
        usedAt,
      );
    }
  }
}

function rebuildResources(
  repositories: WorkstreamCatalogRebuildRepository[],
): RebuildResource[] {
  const resources = new Map<string, RebuildResource>();
  for (const repository of repositories) {
    for (const entry of repository.resources) {
      const updatedAt = entry.lastUsedAt ?? repository.updatedAt;
      const existing = resources.get(entry.resourceId);
      if (!existing) {
        resources.set(entry.resourceId, {
          entry: structuredClone(entry),
          createdAt: repository.createdAt,
          updatedAt,
        });
      } else {
        if (repository.createdAt < existing.createdAt) existing.createdAt = repository.createdAt;
        if (updatedAt >= existing.updatedAt) {
          existing.entry = structuredClone(entry);
          existing.updatedAt = updatedAt;
        }
      }
    }
  }
  return [...resources.values()].sort((left, right) =>
    left.entry.resourceId.localeCompare(right.entry.resourceId));
}

function catalogFailures(
  repositories: WorkstreamCatalogRebuildRepository[],
): WorkstreamCatalogRebuildFailure[] {
  const failures: WorkstreamCatalogRebuildFailure[] = [];
  const workstreamIds = new Set<string>();
  const runIds = new Set<string>();
  const resources = new Map<string, { locatorKey: string; kind: string }>();
  const locatorOwners = new Map<string, string>();
  const sharedRoots = new Set(repositories.map((repository) => repository.repositoryPath));
  const sharedHeads = new Set(repositories.map((repository) => repository.repositoryHead));
  if (sharedRoots.size > 1 || sharedHeads.size > 1) {
    failures.push({
      contextRepositoryPath: repositories[0]?.repositoryPath ?? "(workstream root)",
      message: "All workstreams must belong to one shared repository HEAD.",
    });
  }
  for (const repository of repositories) {
    if (workstreamIds.has(repository.workstreamId)) {
      failures.push({
        contextRepositoryPath: repository.contextRepositoryPath,
        message: "Duplicate workstream identity exists in the shared repository.",
      });
    }
    workstreamIds.add(repository.workstreamId);
    for (const progress of repository.progress) {
      if (runIds.has(progress.runId)) {
        failures.push({
          contextRepositoryPath: repository.contextRepositoryPath,
          message: "Progress run identity appears more than once: " + progress.runId,
        });
      }
      runIds.add(progress.runId);
    }
    for (const resource of repository.resources) {
      try {
        const locatorKey = resourceLocatorKey(resource.locator);
        const existing = resources.get(resource.resourceId);
        if (existing && (existing.locatorKey !== locatorKey || existing.kind !== resource.kind)) {
          throw new Error("Resource identity has conflicting metadata across workstreams.");
        }
        const locatorOwner = locatorOwners.get(locatorKey);
        if (locatorOwner && locatorOwner !== resource.resourceId) {
          throw new Error("Resource locator has conflicting durable identities across workstreams.");
        }
        resources.set(resource.resourceId, { locatorKey, kind: resource.kind });
        locatorOwners.set(locatorKey, resource.resourceId);
      } catch (error) {
        failures.push({
          contextRepositoryPath: repository.contextRepositoryPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return failures;
}

function validateProgressRequests(
  progress: WorkstreamProgressEntry[],
  requests: WorkstreamRequest[],
): void {
  const requestIds = new Set(requests.map((request) => request.id));
  const unknown = progress.find((entry) => !requestIds.has(entry.requestId));
  if (unknown) {
    throw new Error("Progress references an unknown request: " + unknown.requestId);
  }
}

function requireOneSharedRepository(
  repositories: WorkstreamCatalogRebuildRepository[],
): WorkstreamCatalogRebuildRepository | undefined {
  const first = repositories[0];
  if (!first) return undefined;
  if (repositories.some((repository) =>
    repository.repositoryPath !== first.repositoryPath
    || repository.repositoryHead !== first.repositoryHead)) {
    throw new Error("Catalog rebuild requires exactly one shared repository state.");
  }
  return first;
}

function commitForProgress(
  workstream: WorkstreamCatalogRebuildRepository,
  entry: WorkstreamProgressEntry,
): string {
  return workstream.progressCommits[entry.runId] ?? workstream.head;
}

async function pathCommitHistory(
  repositoryPath: string,
  directory: string,
  fallback: string,
): Promise<{
  createdAt: string;
  updatedAt: string;
  progressCommits: Record<string, string>;
}> {
  const output = await runGitRaw([
    "log",
    "--reverse",
    "--format=%H%x1f%cI%x1f%B%x1e",
    "--",
    directory,
  ], { cwd: repositoryPath });
  const records = output.split("\u001e").map((value) => value.trim()).filter(Boolean);
  const dates: string[] = [];
  const progressCommits: Record<string, string> = {};
  for (const record of records) {
    const [commit = "", date = "", ...messageParts] = record.split("\u001f");
    if (Number.isFinite(Date.parse(date))) dates.push(date);
    const metadata = parseWorkstreamCommit(messageParts.join("\u001f"));
    if (metadata?.event === "workstream_bound_run_finalized") {
      progressCommits[metadata.runId] = commit;
    }
  }
  return {
    createdAt: dates[0] ?? fallback,
    updatedAt: dates.at(-1) ?? fallback,
    progressCommits,
  };
}
