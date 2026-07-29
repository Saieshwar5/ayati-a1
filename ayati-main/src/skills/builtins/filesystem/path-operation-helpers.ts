import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
} from "../../../shared/filesystem-paths.js";
import {
  canonicalizeFilesystemEntryPath,
  observeFilesystemTarget,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  ToolErrorCategory,
  ToolExecutionContext,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import { getWorkspaceRoot } from "../../workspace-paths.js";

export interface FilesystemOperationIssue {
  code: string;
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  recoverable: boolean;
  target: string;
  expected?: unknown;
  actual?: unknown;
  errnoCode?: string;
}

export async function resolveMutationAuthority(
  context?: ToolExecutionContext,
): Promise<{ path: string; kind: "file" | "directory" }> {
  const scope = context?.resourceScope;
  const requestedPath = scope?.authorityPath ?? getWorkspaceRoot();
  return {
    path: await canonicalizeAbsoluteFilesystemPath(requestedPath),
    kind: scope?.authorityKind ?? "directory",
  };
}

export async function resolveContainedMutationPath(
  requestedPath: string,
  context: ToolExecutionContext | undefined,
  operation: string,
): Promise<
  | { ok: true; path: string }
  | { ok: false; issue: FilesystemOperationIssue }
> {
  const authority = await resolveMutationAuthority(context);
  const path = await canonicalizeFilesystemEntryPath(requestedPath);
  if (authorityOwnsPath(authority.path, authority.kind, path)) {
    return { ok: true, path };
  }
  return {
    ok: false,
    issue: {
      code: "PATH_OUTSIDE_SELECTED_MUTATION_ROOT",
      message: `${operation} target is outside the selected absolute destination root ${authority.path}: ${path}`,
      category: "permission",
      retryable: false,
      recoverable: true,
      target: path,
    },
  };
}

export async function resolveReadableSourcePath(path: string): Promise<string> {
  return await canonicalizeFilesystemEntryPath(path);
}

export async function ensureOperationParent(
  path: string,
  createParents: boolean,
  prefix: string,
): Promise<
  | { ok: true; createdPaths: string[] }
  | {
      ok: false;
      issue: FilesystemOperationIssue;
      createdPaths: string[];
    }
> {
  const parent = dirname(path);
  const missing: string[] = [];
  let current = parent;
  while (true) {
    const state = await observeFilesystemTarget(current);
    if (state.kind === "directory") break;
    if (state.kind !== "missing") {
      return {
        ok: false,
        issue: {
          code: `${prefix}_INVALID_PATH`,
          message: `A destination parent path is ${state.kind}: ${current}`,
          category: "semantic",
          retryable: false,
          recoverable: true,
          target: current,
          actual: summarizeFilesystemTargetState(state),
        },
        createdPaths: [],
      };
    }
    missing.push(current);
    const next = dirname(current);
    if (next === current) {
      return {
        ok: false,
        issue: {
          code: `${prefix}_PARENT_MISSING`,
          message: `No existing directory ancestor is available for ${path}.`,
          category: "missing_path",
          retryable: false,
          recoverable: true,
          target: path,
        },
        createdPaths: [],
      };
    }
    current = next;
  }
  missing.reverse();
  if (!createParents && missing.length > 0) {
    return {
      ok: false,
      issue: {
        code: `${prefix}_PARENT_MISSING`,
        message: `Destination parent directory does not exist: ${parent}`,
        category: "missing_path",
        retryable: true,
        recoverable: true,
        target: parent,
      },
      createdPaths: [],
    };
  }
  try {
    if (missing.length > 0) {
      await mkdir(parent, { recursive: true });
    }
    return {
      ok: true,
      createdPaths: await existingDirectories(missing),
    };
  } catch (error) {
    return {
      ok: false,
      issue: classifyFilesystemOperationError(error, parent, prefix),
      createdPaths: await existingDirectories(missing),
    };
  }
}

export function classifyFilesystemOperationError(
  error: unknown,
  fallbackTarget: string,
  prefix: string,
): FilesystemOperationIssue {
  const errno = error as NodeJS.ErrnoException;
  const target = typeof errno.path === "string" ? errno.path : fallbackTarget;
  const detail = error instanceof Error
    ? error.message
    : "Unknown filesystem operation error.";
  switch (errno.code) {
    case "EACCES":
    case "EPERM":
      return issue(
        `${prefix}_PERMISSION_DENIED`,
        `Permission denied for ${target}: ${detail}`,
        "permission",
        false,
        target,
        errno.code,
      );
    case "EROFS":
      return issue(
        `${prefix}_READ_ONLY_FILESYSTEM`,
        `The destination filesystem is read-only: ${target}`,
        "permission",
        false,
        target,
        errno.code,
      );
    case "ENOENT":
      return issue(
        `${prefix}_PATH_NOT_FOUND`,
        `A required filesystem path does not exist: ${target}`,
        "missing_path",
        true,
        target,
        errno.code,
      );
    case "ENOTDIR":
    case "EISDIR":
    case "EINVAL":
      return issue(
        `${prefix}_INVALID_PATH`,
        `The requested path or path kind is invalid for ${target}: ${detail}`,
        "semantic",
        false,
        target,
        errno.code,
      );
    case "EEXIST":
    case "ENOTEMPTY":
      return issue(
        `${prefix}_DESTINATION_EXISTS`,
        `The destination already exists or is not empty: ${target}`,
        "conflict",
        true,
        target,
        errno.code,
      );
    case "ENOSPC":
    case "EDQUOT":
      return issue(
        `${prefix}_STORAGE_FULL`,
        `The destination has insufficient storage: ${target}`,
        "transient",
        true,
        target,
        errno.code,
      );
    case "EMFILE":
    case "ENFILE":
    case "EBUSY":
      return issue(
        `${prefix}_TEMPORARY_FAILURE`,
        `The filesystem is temporarily unavailable for ${target}: ${detail}`,
        "transient",
        true,
        target,
        errno.code,
      );
    default:
      return issue(
        `${prefix}_FAILED`,
        detail,
        "unknown",
        false,
        target,
        errno.code,
      );
  }
}

export function authorityOwnsPath(
  authorityPath: string,
  authorityKind: "file" | "directory",
  path: string,
): boolean {
  return authorityKind === "file"
    ? resolve(authorityPath) === resolve(path)
    : filesystemPathIsWithin(authorityPath, path);
}

export function filesystemValidationFailure(
  code: string,
  message: string,
  suggestedNextAction: string,
): ToolResult {
  return {
    ok: false,
    error: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      error: {
        category: "validation",
        code,
        message,
        retryable: true,
        recoverable: true,
        suggestedNextActions: [suggestedNextAction],
      },
    },
  };
}

export function recoverableFilesystemErrorContract(
  category: ToolStructuredError["category"],
  retryable: boolean,
): {
  category: ToolStructuredError["category"];
  retryable: boolean;
  recoverable: boolean;
  suggestedNextActions: string[];
} {
  return {
    category,
    retryable,
    recoverable: true,
    suggestedNextActions: ["Resolve the reported filesystem condition and retry."],
  };
}

function issue(
  code: string,
  message: string,
  category: ToolErrorCategory,
  retryable: boolean,
  target: string,
  errnoCode?: string,
): FilesystemOperationIssue {
  return {
    code,
    message,
    category,
    retryable,
    recoverable: true,
    target,
    ...(errnoCode ? { errnoCode } : {}),
  };
}

async function existingDirectories(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    if ((await observeFilesystemTarget(path)).kind === "directory") {
      existing.push(path);
    }
  }
  return existing;
}
