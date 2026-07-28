import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import {
  configureAyatiGitIdentity,
  gitCommitEnvironment,
  runGit,
  runGitRaw,
} from "../git/git-process.js";
import {
  migrateWorkstreamCard,
  migrateWorkstreamRequest,
} from "../workstreams/legacy-workstream-context.js";
import {
  isRequestId,
  requireRequestPath,
  WORKSTREAM_CARD_PATH,
  WORKSTREAM_PROGRESS_PATH,
  WORKSTREAM_RESOURCES_PATH,
} from "../workstreams/workstream-repository-layout.js";
import {
  parseWorkstreamProgress,
  renderWorkstreamProgress,
} from "../workstreams/workstream-progress.js";
import {
  parseWorkstreamResourceManifest,
} from "../workstreams/workstream-resource-manifest.js";
import type { WorkstreamRequest } from "../workstreams/workstream-request.js";
import { validateWorkstreamRepository } from "../workstreams/workstream-repository-validator.js";
import {
  rebuildWorkstreamCatalog,
} from "./workstream-catalog-rebuild-service.js";

export interface NestedWorkstreamMigrationInventory {
  workstreamId: string;
  directoryName: string;
  sourcePath: string;
  sourceHead: string;
  requestCount: number;
  progressCount: number;
  resourceCount: number;
  convertedFiles: number;
}

export interface WorkstreamSharedRepositoryMigrationFailure {
  sourcePath: string;
  message: string;
}

export interface WorkstreamSharedRepositoryMigrationResult {
  scannedDirectories: number;
  workstreams: NestedWorkstreamMigrationInventory[];
  failures: WorkstreamSharedRepositoryMigrationFailure[];
  applied: boolean;
  archiveRoot?: string;
  sharedRepositoryHead?: string;
}

interface PreparedWorkstream {
  inventory: NestedWorkstreamMigrationInventory;
  files: Map<string, string>;
}

export async function migrateToSharedWorkstreamRepository(input: {
  workstreamRoot: string;
  archiveRoot?: string;
  database?: ContextDatabase;
  now: string;
  confirm: boolean;
}): Promise<WorkstreamSharedRepositoryMigrationResult> {
  const root = await realpath(resolve(input.workstreamRoot)).catch(() => undefined);
  const candidates = root ? await nestedWorkstreamDirectories(root) : [];
  const prepared: PreparedWorkstream[] = [];
  const failures: WorkstreamSharedRepositoryMigrationFailure[] = [];
  if (root && await pathExists(join(root, ".git"))) {
    failures.push({
      sourcePath: root,
      message: "The workstream root is already a Git repository; nested migration is not applicable.",
    });
  }
  for (const candidate of candidates) {
    try {
      prepared.push(await prepareNestedWorkstream(candidate));
    } catch (error) {
      failures.push({
        sourcePath: candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const identities = new Set<string>();
  for (const item of prepared) {
    if (identities.has(item.inventory.workstreamId)) {
      failures.push({
        sourcePath: item.inventory.sourcePath,
        message: "Duplicate workstream identity exists in nested repositories.",
      });
    }
    identities.add(item.inventory.workstreamId);
  }
  failures.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const preview = {
    scannedDirectories: candidates.length,
    workstreams: prepared.map((item) => item.inventory),
    failures,
    applied: false,
  } satisfies WorkstreamSharedRepositoryMigrationResult;
  if (!input.confirm) return preview;
  if (!root || prepared.length === 0) {
    throw new Error("Shared-repository migration requires at least one valid nested workstream.");
  }
  if (failures.length > 0) {
    throw new Error("Shared-repository migration refused because validation failed.");
  }
  if (!input.archiveRoot || !input.database) {
    throw new Error("Confirmed migration requires an archive root and an empty V9 database.");
  }
  const archiveRoot = resolve(input.archiveRoot);
  if (dirname(archiveRoot) !== dirname(root)) {
    throw new Error("Migration archive must be a sibling of the workstream root for atomic switching.");
  }
  if (await pathExists(archiveRoot)) {
    throw new Error("Migration archive root already exists: " + archiveRoot);
  }
  const temporaryRoot = root + ".shared-migration";
  if (await pathExists(temporaryRoot)) {
    throw new Error("Migration staging root already exists: " + temporaryRoot);
  }
  await buildSharedRepository(temporaryRoot, prepared, input.now);
  await validatePreparedRepository(temporaryRoot, prepared);
  await mkdir(archiveRoot);
  const manifestPath = join(archiveRoot, "manifest.json");
  const manifest: Record<string, unknown> = {
    version: 1,
    operation: "workstream_shared_repository_migration",
    status: "prepared",
    createdAt: input.now,
    sourceRoot: root,
    archiveRoot,
    workstreams: prepared.map((item) => item.inventory),
  };
  await writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const archivedWorkstreams = join(archiveRoot, "workstreams");
  let sourceArchived = false;
  let sharedInstalled = false;
  try {
    await rename(root, archivedWorkstreams);
    sourceArchived = true;
    await rename(temporaryRoot, root);
    sharedInstalled = true;
    await rebuildWorkstreamCatalog({
      workstreamRoot: root,
      database: input.database,
      now: input.now,
      confirm: true,
    });
    const head = await runGit(["rev-parse", "HEAD"], { cwd: root });
    Object.assign(manifest, {
      status: "completed",
      completedAt: input.now,
      sharedRepositoryHead: head,
    });
    await writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return {
      ...preview,
      applied: true,
      archiveRoot,
      sharedRepositoryHead: head,
    };
  } catch (error) {
    Object.assign(manifest, {
      status: "failed",
      failedAt: input.now,
      error: error instanceof Error ? error.message : String(error),
    });
    if (sharedInstalled) {
      const failedShared = join(archiveRoot, "failed-shared-repository");
      await rename(root, failedShared).catch(() => undefined);
    }
    if (sourceArchived && !await pathExists(root)) {
      await rename(archivedWorkstreams, root).catch(() => undefined);
    }
    await writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    throw error;
  }
}

async function nestedWorkstreamDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("W-")) continue;
    const candidate = join(root, entry.name);
    if (await pathExists(join(candidate, ".git"))) result.push(await realpath(candidate));
  }
  return result;
}

async function prepareNestedWorkstream(sourcePath: string): Promise<PreparedWorkstream> {
  const directoryName = basename(sourcePath);
  const workstreamId = /^((?:W-\d{8}-\d{4}))-[a-z0-9][a-z0-9-]*$/.exec(
    directoryName,
  )?.[1];
  if (!workstreamId) {
    throw new Error("Nested workstream directory name is not canonical.");
  }
  const gitRoot = resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: sourcePath }));
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: sourcePath });
  const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: sourcePath });
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], {
    cwd: sourcePath,
  });
  if (gitRoot !== resolve(sourcePath) || branch !== "main" || bare !== "false" || status) {
    throw new Error("Nested repository must be a clean, attached, non-bare main branch.");
  }
  const sourceHead = await runGit(["rev-parse", "HEAD"], { cwd: sourcePath });
  const tracked = lines(await runGit([
    "ls-tree",
    "-r",
    "--name-only",
    sourceHead,
  ], { cwd: sourcePath }));
  const requestPaths = tracked.filter((path) => path.startsWith("requests/"));
  const allowed = new Set([
    WORKSTREAM_CARD_PATH,
    WORKSTREAM_PROGRESS_PATH,
    WORKSTREAM_RESOURCES_PATH,
    ...requestPaths,
  ]);
  const unexpected = tracked.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error("Nested repository tracks non-context paths: " + unexpected.join(", "));
  }
  for (const required of [
    WORKSTREAM_CARD_PATH,
    WORKSTREAM_RESOURCES_PATH,
  ]) {
    if (!allowed.has(required) || !tracked.includes(required)) {
      throw new Error("Nested repository is missing " + required + ".");
    }
  }
  if (requestPaths.length === 0) throw new Error("Nested repository has no request files.");
  const updatedAt = await latestCommitDate(sourcePath);
  const files = new Map<string, string>();
  let convertedFiles = 0;
  const cardMigration = migrateWorkstreamCard(
    await committedFile(sourcePath, WORKSTREAM_CARD_PATH),
    workstreamId,
  );
  files.set(WORKSTREAM_CARD_PATH, cardMigration.content);
  if (cardMigration.migrated) convertedFiles += 1;
  const requests: WorkstreamRequest[] = [];
  for (const path of requestPaths.sort()) {
    const normalizedPath = requireRequestPath(path);
    const requestId = basename(normalizedPath).slice(0, 6);
    if (!isRequestId(requestId)) throw new Error("Request path has an invalid identity: " + path);
    const migration = migrateWorkstreamRequest({
      content: await committedFile(sourcePath, path),
      workstreamId,
      requestId,
      relativePath: normalizedPath,
      updatedAt,
    });
    requests.push(migration.request);
    files.set(normalizedPath, migration.content);
    if (migration.migrated) convertedFiles += 1;
  }
  validateCurrentRequest(cardMigration.card.currentRequest, cardMigration.card.status, requests);
  const progressTracked = tracked.includes(WORKSTREAM_PROGRESS_PATH);
  const progressContent = progressTracked
    ? await committedFile(sourcePath, WORKSTREAM_PROGRESS_PATH)
    : renderWorkstreamProgress([]);
  const progress = parseWorkstreamProgress(progressContent);
  const knownRequestIds = new Set(requests.map((request) => request.id));
  const unknownProgress = progress.find((entry) => !knownRequestIds.has(entry.requestId));
  if (unknownProgress) {
    throw new Error("Progress references unknown request " + unknownProgress.requestId + ".");
  }
  files.set(WORKSTREAM_PROGRESS_PATH, progressContent);
  if (!progressTracked) convertedFiles += 1;
  const resourcesContent = await committedFile(sourcePath, WORKSTREAM_RESOURCES_PATH);
  const resources = parseWorkstreamResourceManifest(resourcesContent, workstreamId);
  files.set(WORKSTREAM_RESOURCES_PATH, resourcesContent);
  return {
    inventory: {
      workstreamId,
      directoryName,
      sourcePath,
      sourceHead,
      requestCount: requests.length,
      progressCount: progress.length,
      resourceCount: resources.resources.length,
      convertedFiles,
    },
    files,
  };
}

async function buildSharedRepository(
  root: string,
  workstreams: PreparedWorkstream[],
  at: string,
): Promise<void> {
  await mkdir(root);
  await runGit(["init", "--initial-branch=main"], { cwd: root });
  await configureAyatiGitIdentity(root);
  for (const workstream of workstreams) {
    for (const [path, content] of workstream.files) {
      await writeFileAtomically(join(root, workstream.inventory.directoryName, path), content);
    }
  }
  const expectedPaths = workstreams.flatMap((workstream) =>
    [...workstream.files.keys()].map((path) => workstream.inventory.directoryName + "/" + path)
  ).sort();
  await runGit(["add", "--", ...expectedPaths], { cwd: root });
  const staged = lines(await runGit(["diff", "--cached", "--name-only"], { cwd: root })).sort();
  if (JSON.stringify(staged) !== JSON.stringify(expectedPaths)) {
    throw new Error("Shared migration staged paths do not match the validated context inventory.");
  }
  await runGit([
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "migrate workstreams to shared notebook",
  ], {
    cwd: root,
    env: gitCommitEnvironment(at),
  });
  if (await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: root })) {
    throw new Error("Shared migration repository is not clean after its baseline commit.");
  }
}

async function validatePreparedRepository(
  root: string,
  workstreams: PreparedWorkstream[],
): Promise<void> {
  for (const workstream of workstreams) {
    await validateWorkstreamRepository({
      workstreamRoot: root,
      contextRepositoryPath: join(root, workstream.inventory.directoryName),
      expectedWorkstreamId: workstream.inventory.workstreamId,
      requestReadMode: "all",
    });
  }
}

function validateCurrentRequest(
  currentRequest: string | null,
  workstreamStatus: "active" | "paused" | "archived",
  requests: WorkstreamRequest[],
): void {
  const active = requests.filter((request) => request.status === "active");
  if (active.length > 1
    || (workstreamStatus !== "active" && active.length > 0)
    || (currentRequest === null && active.length > 0)
    || (currentRequest !== null
      && (active.length !== 1 || active[0]?.id !== currentRequest))) {
    throw new Error("Migrated request lifecycle violates the one-active-request invariant.");
  }
}

async function committedFile(repositoryPath: string, path: string): Promise<string> {
  return await runGitRaw(["show", "HEAD:" + path], { cwd: repositoryPath });
}

async function latestCommitDate(repositoryPath: string): Promise<string> {
  const value = await runGit(["show", "-s", "--format=%cI", "HEAD"], {
    cwd: repositoryPath,
  });
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Nested repository HEAD has an invalid commit timestamp.");
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
