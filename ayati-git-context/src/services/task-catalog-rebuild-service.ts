import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { runGitRaw } from "../git/git-process.js";
import { parseSimpleTaskCommit } from "../tasks/task-commit-metadata.js";
import { validateTaskRepository } from "../tasks/task-repository-validator.js";

const MAX_SCANNED_DIRECTORIES = 50_000;
const MAX_SCAN_DEPTH = 12;
const SKIPPED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".pnpm-store",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface TaskCatalogRebuildRepository {
  taskId: string;
  repositoryPath: string;
  placement: "managed" | "requested";
  trustedRoot: string;
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
}

export interface TaskCatalogRebuildFailure {
  repositoryPath: string;
  message: string;
}

export interface TaskCatalogRebuildResult {
  scannedDirectories: number;
  repositories: TaskCatalogRebuildRepository[];
  failures: TaskCatalogRebuildFailure[];
  applied: boolean;
}

export async function rebuildTaskCatalog(input: {
  taskRoot: string;
  trustedRoots: string[];
  now: string;
  database?: ContextDatabase;
  confirm: boolean;
}): Promise<TaskCatalogRebuildResult> {
  const taskRoot = resolve(input.taskRoot);
  const roots = await canonicalRoots([dirname(taskRoot), ...input.trustedRoots]);
  const scan = await findTaskRepositories(taskRoot, roots);
  const repositories: TaskCatalogRebuildRepository[] = [];
  const failures: TaskCatalogRebuildFailure[] = [];
  for (const candidate of scan.paths) {
    const placement = dirname(candidate) === await realpath(taskRoot).catch(() => "")
      ? "managed" as const
      : "requested" as const;
    const trustedRoot = placement === "managed"
      ? await realpath(taskRoot)
      : mostSpecificRoot(roots, candidate);
    if (!trustedRoot) {
      failures.push({
        repositoryPath: candidate,
        message: "Repository is outside the configured catalog rebuild roots.",
      });
      continue;
    }
    try {
      const validation = await validateTaskRepository({
        taskRoot,
        repositoryPath: candidate,
        placement,
        trustedRoot,
        requestReadMode: "all",
      });
      const dates = await commitDates(
        candidate,
        validation.head,
        validation.taskId,
        input.now,
      );
      repositories.push({
        taskId: validation.taskId,
        repositoryPath: validation.repositoryPath,
        placement,
        trustedRoot,
        branch: validation.branch,
        head: validation.head,
        title: validation.taskCard.title,
        objective: validation.taskCard.purpose,
        lifecycleStatus: validation.taskCard.status,
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
      });
    } catch (error) {
      failures.push({
        repositoryPath: candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  repositories.sort((left, right) => left.taskId.localeCompare(right.taskId));
  failures.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
  validateUniqueRepositories(repositories, failures);
  if (!input.confirm) {
    return {
      scannedDirectories: scan.scannedDirectories,
      repositories,
      failures,
      applied: false,
    };
  }
  if (!input.database) throw new Error("Catalog rebuild confirmation requires the V3 database.");
  if (failures.length > 0) {
    throw new Error("Catalog rebuild refused because one or more task repositories failed validation.");
  }
  applyCatalog(input.database, repositories, input.now);
  return {
    scannedDirectories: scan.scannedDirectories,
    repositories,
    failures,
    applied: true,
  };
}

async function findTaskRepositories(
  taskRoot: string,
  trustedRoots: string[],
): Promise<{ paths: string[]; scannedDirectories: number }> {
  const found = new Set<string>();
  const visited = new Set<string>();
  let scannedDirectories = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    const identity = resolve(directory);
    if (visited.has(identity)) return;
    visited.add(identity);
    scannedDirectories++;
    if (scannedDirectories > MAX_SCANNED_DIRECTORIES) {
      throw new Error(`Catalog rebuild exceeded ${MAX_SCANNED_DIRECTORIES} directories.`);
    }
    if (await isTaskRepository(directory)) {
      found.add(await realpath(directory));
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EACCES") return [];
        throw error;
      },
    );
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await visit(join(directory, entry.name), depth + 1);
    }
  };
  const managedRoot = await realpath(taskRoot).catch(() => undefined);
  if (managedRoot) await visit(managedRoot, 0);
  for (const root of trustedRoots) {
    if (root === managedRoot || isWithin(managedRoot ?? "", root)) continue;
    await visit(root, 0);
  }
  return { paths: [...found].sort(), scannedDirectories };
}

async function canonicalRoots(values: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const value of values) {
    const root = await realpath(resolve(value)).catch(() => undefined);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots.sort((left, right) => right.length - left.length);
}

async function isTaskRepository(directory: string): Promise<boolean> {
  const card = await lstat(join(directory, ".ayati", "task.md")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    },
  );
  return Boolean(card?.isFile() && !card.isSymbolicLink());
}

function mostSpecificRoot(roots: string[], repositoryPath: string): string | undefined {
  return roots.find((root) => root !== repositoryPath && isWithin(root, repositoryPath));
}

function validateUniqueRepositories(
  repositories: TaskCatalogRebuildRepository[],
  failures: TaskCatalogRebuildFailure[],
): void {
  for (let index = 0; index < repositories.length; index++) {
    const current = repositories[index];
    if (!current) continue;
    const conflict = repositories.slice(index + 1).find((candidate) =>
      candidate.taskId === current.taskId
        || isWithin(current.repositoryPath, candidate.repositoryPath)
        || isWithin(candidate.repositoryPath, current.repositoryPath));
    if (conflict) {
      failures.push({
        repositoryPath: current.repositoryPath,
        message: conflict.taskId === current.taskId
          ? `Duplicate task identity also exists at ${conflict.repositoryPath}.`
          : `Task repository overlaps ${conflict.repositoryPath}.`,
      });
    }
  }
}

function applyCatalog(
  database: ContextDatabase,
  repositories: TaskCatalogRebuildRepository[],
  now: string,
): void {
  const taskCount = database.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number };
  if (Number(taskCount.count) !== 0) {
    throw new Error("Catalog rebuild requires an empty task catalog.");
  }
  const session = database.prepare([
    "SELECT session_id FROM sessions ORDER BY created_at DESC, session_id DESC LIMIT 1",
  ].join(" ")).get() as { session_id: string } | undefined;
  if (!session) {
    throw new Error("Catalog rebuild requires an initialized V3 daily session; start and stop Ayati once first.");
  }
  database.transaction(() => {
    for (const repository of repositories) {
      const current = repository.currentRequest;
      database.prepare([
        "INSERT INTO tasks(task_id, repository_path, branch, head_sha, title_cache,",
        "objective_cache, placement_mode, trusted_root, registration_head_before,",
        "registration_approval_id, registration_snapshot_hash, baseline_paths_json,",
        "registration_excluded_paths_json, lifecycle_status, repository_health,",
        "current_request_id, current_request_title, current_request_status, status,",
        "created_session_id, created_at, updated_at)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" ")).run(
        repository.taskId,
        repository.repositoryPath,
        repository.branch,
        repository.head,
        repository.title,
        repository.objective,
        repository.placement,
        repository.trustedRoot,
        repository.lifecycleStatus,
        repository.repositoryHealth,
        current?.id ?? null,
        current?.title ?? null,
        current?.status ?? null,
        repository.lifecycleStatus === "archived" ? "archived" : "active",
        session.session_id,
        repository.createdAt,
        repository.updatedAt || now,
      );
      database.prepare([
        "INSERT INTO task_search(task_id, title, objective, current_request, repository_path)",
        "VALUES (?, ?, ?, ?, ?)",
      ].join(" ")).run(
        repository.taskId,
        repository.title,
        repository.objective,
        current ? `${current.title}\n${current.request}` : "",
        repository.repositoryPath,
      );
    }
  });
}

async function commitDates(
  repositoryPath: string,
  head: string,
  taskId: string,
  fallback: string,
): Promise<{ createdAt: string; updatedAt: string }> {
  const history = await runGitRaw(["log", "--format=%cI%x1f%B%x1e", head], {
    cwd: repositoryPath,
  });
  const commits = history.split("\u001e").map((record) => record.trim()).filter(Boolean)
    .map((record) => {
      const separator = record.indexOf("\u001f");
      const date = separator >= 0 ? record.slice(0, separator).trim() : "";
      const message = separator >= 0 ? record.slice(separator + 1) : record;
      return {
        date,
        metadata: /(?:^|\n)Ayati-Event:\s*/.test(message)
          ? parseSimpleTaskCommit(message)
          : undefined,
      };
    });
  const identities = commits.filter((commit) =>
    commit.metadata?.event === "task_created" && commit.metadata.taskId === taskId);
  if (identities.length !== 1) {
    throw new Error(`Task history must contain exactly one identity commit for ${taskId}.`);
  }
  return {
    createdAt: Number.isFinite(Date.parse(identities[0]?.date ?? ""))
      ? identities[0]!.date
      : fallback,
    updatedAt: Number.isFinite(Date.parse(commits[0]?.date ?? ""))
      ? commits[0]!.date
      : fallback,
  };
}

function isWithin(parent: string, candidate: string): boolean {
  if (!parent) return false;
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}
