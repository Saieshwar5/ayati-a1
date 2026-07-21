import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { runGitRaw } from "../git/git-process.js";
import {
  resourceIdForLocator,
  resourceLocatorKey,
} from "../repositories/resource-records.js";
import { parseWorkstreamCommit } from "../workstreams/workstream-commit-metadata.js";
import { WORKSTREAM_CARD_PATH } from "../workstreams/workstream-repository-layout.js";
import type { WorkstreamResourceManifestEntry } from "../workstreams/workstream-resource-manifest.js";
import { validateWorkstreamRepository } from "../workstreams/workstream-repository-validator.js";

export interface WorkstreamCatalogRebuildRepository {
  workstreamId: string;
  contextRepositoryPath: string;
  branch: string;
  head: string;
  title: string;
  objective: string;
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external";
  currentRequest?: {
    id: string;
    title: string;
    status: "active";
    request: string;
  };
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
  const candidates = workstreamRoot ? await directRepositories(workstreamRoot) : [];
  const repositories: WorkstreamCatalogRebuildRepository[] = [];
  const failures: WorkstreamCatalogRebuildFailure[] = [];
  for (const candidate of candidates) {
    try {
      const validation = await validateWorkstreamRepository({
        workstreamRoot: workstreamRoot!,
        contextRepositoryPath: candidate,
        requestReadMode: "all",
      });
      const dates = await commitDates(candidate, validation.head, validation.workstreamId, input.now);
      repositories.push({
        workstreamId: validation.workstreamId,
        contextRepositoryPath: validation.contextRepositoryPath,
        branch: validation.branch,
        head: validation.head,
        title: validation.workstreamCard.title,
        objective: validation.workstreamCard.purpose,
        lifecycleStatus: validation.workstreamCard.status,
        repositoryHealth: validation.health,
        ...(validation.currentRequest ? {
          currentRequest: {
            id: validation.currentRequest.id,
            title: validation.currentRequest.title,
            status: "active",
            request: validation.currentRequest.request,
          },
        } : {}),
        ...dates,
        resources: validation.resourceManifest.resources,
      });
    } catch (error) {
      failures.push({
        contextRepositoryPath: candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  repositories.sort((left, right) => left.workstreamId.localeCompare(right.workstreamId));
  const duplicate = repositories.find((repository, index) =>
    repositories.slice(index + 1).some((candidate) => candidate.workstreamId === repository.workstreamId));
  if (duplicate) {
    failures.push({
      contextRepositoryPath: duplicate.contextRepositoryPath,
      message: "Duplicate workstream identity exists in the managed context root.",
    });
  }
  failures.push(...resourceCatalogFailures(repositories));
  failures.sort((left, right) => left.contextRepositoryPath.localeCompare(right.contextRepositoryPath)
    || left.message.localeCompare(right.message));
  if (!input.confirm) {
    return { scannedDirectories: candidates.length, repositories, failures, applied: false };
  }
  if (!input.database) throw new Error("Catalog rebuild confirmation requires the V7 database.");
  if (failures.length > 0) throw new Error("Catalog rebuild refused because validation failed.");
  applyCatalog(input.database, repositories, input.now);
  return { scannedDirectories: candidates.length, repositories, failures, applied: true };
}

async function directRepositories(workstreamRoot: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(workstreamRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
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
  const workstreamCount = database.prepare(
    "SELECT COUNT(*) AS count FROM workstreams",
  ).get() as { count: number };
  const resourceCount = database.prepare(
    "SELECT COUNT(*) AS count FROM resources",
  ).get() as { count: number };
  if (Number(workstreamCount.count) !== 0 || Number(resourceCount.count) !== 0) {
    throw new Error("Catalog rebuild requires an empty workstream and resource catalog.");
  }
  database.transaction(() => {
    for (const repository of repositories) insertWorkstream(database, repository, now);
    for (const item of rebuildResources(repositories)) insertResource(database, item);
    for (const repository of repositories) insertResourceBindings(database, repository);
  });
}

function insertWorkstream(
  database: ContextDatabase,
  repository: WorkstreamCatalogRebuildRepository,
  now: string,
): void {
  const current = repository.currentRequest;
  database.prepare([
    "INSERT INTO workstreams(workstream_id, repository_path, branch, head_sha, title_cache,",
    "objective_cache, lifecycle_status, repository_health, current_request_id,",
    "current_request_title, current_request_status, status, created_by_run_id, created_at, updated_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
  ].join(" ")).run(
    repository.workstreamId,
    repository.contextRepositoryPath,
    repository.branch,
    repository.head,
    repository.title,
    repository.objective,
    repository.lifecycleStatus,
    repository.repositoryHealth,
    current?.id ?? null,
    current?.title ?? null,
    current?.status ?? null,
    repository.lifecycleStatus === "archived" ? "archived" : "active",
    repository.createdAt,
    repository.updatedAt || now,
  );
  database.prepare([
    "INSERT INTO workstream_search(workstream_id, title, objective, current_request)",
    "VALUES (?, ?, ?, ?)",
  ].join(" ")).run(
    repository.workstreamId,
    repository.title,
    repository.objective,
    current ? current.title + "\n" + current.request : "",
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
  database.prepare([
    "INSERT INTO resources(",
    "resource_id, kind, origin, locator_kind, locator_key, locator_json, display_name,",
    "description, aliases_json, metadata_status, described_version_key, media_type, size_bytes,",
    "content_hash, current_version_key, current_version_json, availability, metadata_json,",
    "created_by_run_id, last_verified_run_id, last_verified_at, created_at, updated_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enriched', ?, ?, ?, ?, ?, ?, ?, '{}',",
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
    resource.version.key,
    resource.mediaType ?? null,
    resource.version.sizeBytes ?? null,
    resource.version.sha256 ?? null,
    resource.version.key,
    JSON.stringify(resource.version),
    resource.availability,
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
    locatorKey,
  );
}

function insertResourceBindings(
  database: ContextDatabase,
  repository: WorkstreamCatalogRebuildRepository,
): void {
  for (const resource of repository.resources) {
    const usedAt = resource.lastUsedAt ?? repository.updatedAt;
    database.prepare([
      "INSERT INTO workstream_resources(",
      "workstream_id, resource_id, role, access, is_primary, first_bound_run_id,",
      "last_used_run_id, bound_at, last_used_at",
      ") VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
    ].join(" ")).run(
      repository.workstreamId,
      resource.resourceId,
      resource.role,
      resource.access,
      resource.primary ? 1 : 0,
      repository.createdAt,
      usedAt,
    );
    for (const requestId of resource.requestIds) {
      database.prepare([
        "INSERT INTO request_resources(",
        "workstream_id, request_id, resource_id, role, created_by_run_id, created_at",
        ") VALUES (?, ?, ?, ?, NULL, ?)",
      ].join(" ")).run(
        repository.workstreamId,
        requestId,
        resource.resourceId,
        resource.role,
        usedAt,
      );
    }
  }
}

function resourceCatalogFailures(
  repositories: WorkstreamCatalogRebuildRepository[],
): WorkstreamCatalogRebuildFailure[] {
  const seen = new Map<string, { locatorKey: string; kind: string }>();
  const failures: WorkstreamCatalogRebuildFailure[] = [];
  for (const repository of repositories) {
    for (const resource of repository.resources) {
      try {
        const locatorKey = resourceLocatorKey(resource.locator);
        const expectedId = resource.locator.kind === "managed_blob"
          ? resource.locator.resourceId
          : resourceIdForLocator(locatorKey);
        if (expectedId !== resource.resourceId) {
          throw new Error("Resource identity does not match its durable locator.");
        }
        const existing = seen.get(resource.resourceId);
        if (existing && (existing.locatorKey !== locatorKey || existing.kind !== resource.kind)) {
          throw new Error("Resource identity has conflicting durable metadata across workstreams.");
        }
        seen.set(resource.resourceId, { locatorKey, kind: resource.kind });
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

function rebuildResources(repositories: WorkstreamCatalogRebuildRepository[]): RebuildResource[] {
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
        continue;
      }
      if (repository.createdAt < existing.createdAt) existing.createdAt = repository.createdAt;
      if (updatedAt >= existing.updatedAt) {
        existing.entry = structuredClone(entry);
        existing.updatedAt = updatedAt;
      }
    }
  }
  return [...resources.values()].sort((left, right) =>
    left.entry.resourceId.localeCompare(right.entry.resourceId));
}

async function commitDates(
  contextRepositoryPath: string,
  head: string,
  workstreamId: string,
  fallback: string,
): Promise<{ createdAt: string; updatedAt: string }> {
  const history = await runGitRaw(["log", "--format=%cI%x1f%B%x1e", head], {
    cwd: contextRepositoryPath,
  });
  const commits = history.split("\u001e").map((record) => record.trim()).filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\u001f");
      const date = separator >= 0 ? record.slice(0, separator).trim() : "";
      const message = separator >= 0 ? record.slice(separator + 1) : record;
      return { date, metadata: parseWorkstreamCommit(message) };
    });
  const identity = commits.find((commit) =>
    commit.metadata?.event === "workstream_created" && commit.metadata.workstreamId === workstreamId);
  if (!identity) throw new Error("Workstream history is missing its identity commit.");
  return {
    createdAt: Number.isFinite(Date.parse(identity.date)) ? identity.date : fallback,
    updatedAt: Number.isFinite(Date.parse(commits[0]?.date ?? "")) ? commits[0]!.date : fallback,
  };
}
