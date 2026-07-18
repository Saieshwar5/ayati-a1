import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type {
  MutationTarget,
  ResolvedMutationTarget,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";

export async function resolveMutationTargets(
  workingDirectory: string,
  targets: MutationTarget[],
): Promise<ResolvedMutationTarget[]> {
  const workingRoot = await realpath(workingDirectory);
  const seen = new Set<string>();
  const resolved: ResolvedMutationTarget[] = [];
  for (const target of targets) {
    const normalizedPath = normalizeMutationPath(target.path);
    const destination = await resolveTarget(workingRoot, normalizedPath, target.kind);
    const canonicalPath = portableRelativePath(relative(workingRoot, destination));
    validateOwnedPath(canonicalPath, target.path);
    if (seen.has(canonicalPath)) {
      throw invalidTarget(target.path, "Mutation targets resolve to a duplicate path.");
    }
    seen.add(canonicalPath);
    resolved.push({
      path: canonicalPath,
      kind: target.kind,
      resolvedPath: destination,
    });
  }
  return resolved;
}

function normalizeMutationPath(path: string): string {
  if (/[\x00-\x1f\x7f]/.test(path)
    || path.includes("\\")
    || isAbsolute(path)
    || /^[a-zA-Z]:\//.test(path)) {
    throw invalidTarget(path, "Mutation paths must be portable task-relative paths.");
  }
  const normalized = posix.normalize(path.trim());
  if (normalized.length === 0
    || normalized === ".."
    || normalized.startsWith("../")) {
    throw invalidTarget(path, "Mutation path escapes the task checkout.");
  }
  if (normalized === ".") {
    throw invalidTarget(path, "Mutation authority must name a file or bounded subdirectory.");
  }
  const segments = normalized === "." ? [] : normalized.split("/");
  if (segments.includes(".git") || segments.includes(".ayati")) {
    throw invalidTarget(path, "Mutation path targets engine- or Git-owned state.");
  }
  return normalized;
}

function validateOwnedPath(path: string, requestedPath: string): void {
  const segments = path.split("/");
  if (path === "." || segments.includes(".git") || segments.includes(".ayati")) {
    throw invalidTarget(requestedPath, "Mutation path resolves to engine- or Git-owned state.");
  }
}

function portableRelativePath(path: string): string {
  return path.split(sep).join("/") || ".";
}

async function resolveTarget(
  workingRoot: string,
  normalizedPath: string,
  kind: MutationTarget["kind"],
): Promise<string> {
  const segments = normalizedPath === "." ? [] : normalizedPath.split("/");
  let current = workingRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      throw invalidTarget(normalizedPath, "Mutation path contains an empty segment.");
    }
    const candidate = resolve(current, segment);
    let existed = false;
    try {
      await lstat(candidate);
      existed = true;
      const resolvedCandidate = await realpath(candidate);
      requireContained(workingRoot, resolvedCandidate, normalizedPath);
      current = resolvedCandidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof GitContextServiceError) {
          throw error;
        }
        throw invalidTarget(
          normalizedPath,
          "Mutation path could not be resolved: "
            + (error instanceof Error ? error.message : String(error)),
        );
      }
      if (existed) {
        throw invalidTarget(normalizedPath, "Mutation path contains a broken symbolic link.");
      }
      const remaining = segments.slice(index);
      const unresolved = resolve(current, ...remaining);
      requireContained(workingRoot, unresolved, normalizedPath);
      return unresolved;
    }
  }
  const targetStat = await stat(current);
  if (kind === "file" && targetStat.isDirectory()) {
    throw invalidTarget(normalizedPath, "File mutation target resolves to a directory.");
  }
  if (kind === "directory" && !targetStat.isDirectory()) {
    throw invalidTarget(normalizedPath, "Directory mutation target is not a directory.");
  }
  return current;
}

function requireContained(root: string, candidate: string, path: string): void {
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw invalidTarget(path, "Mutation path resolves outside the task checkout.");
  }
}

function invalidTarget(path: string, message: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    details: { path },
  });
}
