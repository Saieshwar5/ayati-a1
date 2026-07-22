import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ResourceKind,
  ResourceMutationTarget,
  ResourceRef,
  ResourceVersion,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { runGitRaw } from "../git/git-process.js";

const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface ResolvedMutationTarget extends ResourceMutationTarget {
  resolvedPath: string;
  rootPath: string;
  resourceKind?: ResourceKind;
}

interface SnapshotEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "missing";
  size: number;
  mode?: number;
  sha256?: string;
  linkTarget?: string;
  gitStatus?: string;
}

export interface MutationResourceSnapshot {
  resourceId: string;
  rootPath: string;
  entries: SnapshotEntry[];
  version: ResourceVersion;
}

export interface MutationOperationSnapshot {
  targets: ResolvedMutationTarget[];
  resources: MutationResourceSnapshot[];
}

export async function resolveMutationTargets(
  resources: ReadonlyMap<string, ResourceRef>,
  targets: ResourceMutationTarget[],
): Promise<ResolvedMutationTarget[]> {
  const resolved: ResolvedMutationTarget[] = [];
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
      if (!mutationPathIsWithin(rootPath, resolvedPath)) {
        throw invalidTarget(target, "Relative mutation target escapes its resource root.");
      }
    }
    await assertResolvedTargetState(target, rootPath, resolvedPath);
    const identity = target.resourceId + "\u0000" + resolvedPath;
    if (scopes.has(identity)) continue;
    scopes.add(identity);
    resolved.push({ ...target, resolvedPath, rootPath, resourceKind: resource.kind });
  }
  return resolved.sort((left, right) => left.resourceId.localeCompare(right.resourceId)
    || left.resolvedPath.localeCompare(right.resolvedPath));
}

export async function snapshotMutationOperation(
  targets: ResolvedMutationTarget[],
  at: string,
): Promise<MutationOperationSnapshot> {
  for (const target of targets) {
    await assertResolvedTargetState(target, target.rootPath, target.resolvedPath);
  }
  const resources: MutationResourceSnapshot[] = [];
  for (const target of targets) {
    if (resources.some((resource) => resource.resourceId === target.resourceId)) continue;
    const resourceTargets = targets.filter((candidate) => candidate.resourceId === target.resourceId);
    resources.push(resourceTargets.some((candidate) => candidate.resourceKind === "git_repository")
      ? await snapshotGitResource(target.resourceId, target.rootPath, resourceTargets, at)
      : await snapshotFilesystemResource(target.resourceId, target.rootPath, at));
  }
  return { targets, resources };
}

export function compareMutationSnapshots(
  before: MutationOperationSnapshot,
  after: MutationOperationSnapshot,
): { changedPaths: string[]; unexpectedPaths: string[] } {
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
    if (target.kind === "directory") return mutationPathIsWithin(target.resolvedPath, path);
    return resolve(target.resolvedPath) === resolve(path);
  }));
  return { changedPaths: ordered, unexpectedPaths };
}

export function parseMutationSnapshot(value: string): MutationOperationSnapshot | undefined {
  if (value === "null") return undefined;
  return JSON.parse(value) as MutationOperationSnapshot;
}

export function mutationPathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

export function mutationPathsOverlap(left: string, right: string): boolean {
  return mutationPathIsWithin(left, right) || mutationPathIsWithin(right, left);
}

async function assertResolvedTargetState(
  target: ResourceMutationTarget,
  rootPath: string,
  resolvedPath: string,
): Promise<void> {
  if (!mutationPathIsWithin(rootPath, resolvedPath)) {
    throw invalidTarget(target, "Mutation target escapes its resource root.");
  }
  await assertNoSymlinkTraversal(rootPath, resolvedPath);
  const state = await lstat(resolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (state?.isSymbolicLink()) {
    throw invalidTarget(target, "Mutation target may not be a symbolic link.");
  }
  if (state && ((target.kind === "file" && !state.isFile())
    || (target.kind === "directory" && !state.isDirectory()))) {
    throw invalidTarget(target, "Mutation target kind does not match the filesystem.");
  }
}

async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  let current = root;
  const rootState = await lstat(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootState?.isSymbolicLink()) {
    throw new ContextEngineServiceError({
      code: "MUTATION_TARGET_INVALID",
      message: "Mutation target traverses a symbolic link.",
      details: { path: current },
    });
  }
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    const state = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!state) break;
    if (state.isSymbolicLink()) {
      throw new ContextEngineServiceError({
        code: "MUTATION_TARGET_INVALID",
        message: "Mutation target traverses a symbolic link.",
        details: { path: current },
      });
    }
  }
}

async function snapshotGitResource(
  resourceId: string,
  rootPath: string,
  targets: ResolvedMutationTarget[],
  at: string,
): Promise<MutationResourceSnapshot> {
  const rootState = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_VERIFICATION_UNAVAILABLE",
      message: "Git resource root is no longer a normal directory.",
      details: { resourceId, rootPath },
    });
  }

  const [listedOutput, statusOutput] = await Promise.all([
    runGitRaw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: rootPath,
    }),
    runGitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: rootPath,
    }),
  ]);
  const statuses = parseGitStatus(statusOutput);
  const paths = new Set(listedOutput.split("\0").filter(Boolean));
  for (const path of statuses.keys()) paths.add(path);
  for (const target of targets) {
    await collectTargetPaths(rootPath, target.resolvedPath, paths);
  }
  if (paths.size > MAX_SNAPSHOT_ENTRIES) verificationLimit(resourceId, "entry count");

  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  for (const itemPath of [...paths].sort((left, right) => left.localeCompare(right))) {
    const path = resolve(rootPath, itemPath);
    if (!mutationPathIsWithin(rootPath, path)) {
      throw new ContextEngineServiceError({
        code: "RESOURCE_VERIFICATION_UNAVAILABLE",
        message: "Git reported a path outside the resource root.",
        details: { resourceId, path: itemPath },
      });
    }
    const entry = await snapshotPath(rootPath, path, statuses.get(itemPath));
    totalBytes += entry.kind === "file" ? entry.size : 0;
    if (totalBytes > MAX_SNAPSHOT_BYTES) verificationLimit(resourceId, "byte count");
    entries.push(entry);
  }
  return snapshotResult(resourceId, rootPath, entries, totalBytes, at, rootState);
}

async function snapshotFilesystemResource(
  resourceId: string,
  rootPath: string,
  at: string,
): Promise<MutationResourceSnapshot> {
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  const rootState = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (rootState?.isSymbolicLink()) {
    throw new ContextEngineServiceError({
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
      const linkTarget = await readlink(path);
      entries.push({
        path: itemPath,
        kind: "symlink",
        size: Buffer.byteLength(linkTarget),
        mode: state.mode & 0o777,
        linkTarget,
      });
      return;
    }
    if (state.isFile()) {
      totalBytes += state.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) verificationLimit(resourceId, "byte count");
      entries.push({
        path: itemPath,
        kind: "file",
        size: state.size,
        mode: state.mode & 0o777,
        sha256: await hashFile(path),
      });
      return;
    }
    if (!state.isDirectory()) {
      throw new ContextEngineServiceError({
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
  return snapshotResult(resourceId, rootPath, entries, totalBytes, at, rootState);
}

function snapshotResult(
  resourceId: string,
  rootPath: string,
  entries: SnapshotEntry[],
  totalBytes: number,
  at: string,
  rootState?: Stats,
): MutationResourceSnapshot {
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

async function collectTargetPaths(
  rootPath: string,
  targetPath: string,
  paths: Set<string>,
): Promise<void> {
  const itemPath = relative(rootPath, targetPath).replaceAll("\\", "/") || ".";
  paths.add(itemPath);
  if (paths.size > MAX_SNAPSHOT_ENTRIES) return;
  const state = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!state?.isDirectory() || state.isSymbolicLink()) return;
  const children = await readdir(targetPath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (targetPath === rootPath && child.name === ".git") continue;
    await collectTargetPaths(rootPath, join(targetPath, child.name), paths);
    if (paths.size > MAX_SNAPSHOT_ENTRIES) return;
  }
}

async function snapshotPath(
  rootPath: string,
  path: string,
  gitStatus?: string,
): Promise<SnapshotEntry> {
  const itemPath = relative(rootPath, path).replaceAll("\\", "/") || ".";
  const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!state) return { path: itemPath, kind: "missing", size: 0, ...(gitStatus ? { gitStatus } : {}) };
  if (state.isSymbolicLink()) {
    const linkTarget = await readlink(path);
    return {
      path: itemPath,
      kind: "symlink",
      size: Buffer.byteLength(linkTarget),
      mode: state.mode & 0o777,
      linkTarget,
      ...(gitStatus ? { gitStatus } : {}),
    };
  }
  if (state.isFile()) {
    return {
      path: itemPath,
      kind: "file",
      size: state.size,
      mode: state.mode & 0o777,
      sha256: await hashFile(path),
      ...(gitStatus ? { gitStatus } : {}),
    };
  }
  if (state.isDirectory()) {
    return {
      path: itemPath,
      kind: "directory",
      size: 0,
      ...(gitStatus ? { gitStatus } : {}),
    };
  }
  throw new ContextEngineServiceError({
    code: "RESOURCE_VERIFICATION_UNAVAILABLE",
    message: "Resource snapshot contains a non-file entry.",
    details: { path },
  });
}

function parseGitStatus(output: string): Map<string, string> {
  const statuses = new Map<string, string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    statuses.set(path, status);
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (sourcePath) {
        statuses.set(sourcePath, status + ":source");
        index += 1;
      }
    }
  }
  return statuses;
}

function invalidTarget(target: ResourceMutationTarget, message: string): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "MUTATION_TARGET_INVALID",
    message,
    details: { resourceId: target.resourceId, relativePath: target.relativePath ?? null },
  });
}

function verificationLimit(resourceId: string, limit: string): never {
  throw new ContextEngineServiceError({
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
