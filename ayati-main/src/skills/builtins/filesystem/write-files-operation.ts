import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
} from "../../../shared/filesystem-paths.js";
import {
  filesystemPreconditionMap,
  observeFilesystemTarget,
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  FilesystemTargetState,
  ToolErrorCategory,
  ToolExecutionContext,
} from "../../types.js";
import {
  describeMutationAuthorities,
  mutationAuthoritiesOwnPath,
  resolveMutationAuthorities,
} from "./mutation-authority.js";
import type {
  WriteFileResult,
  WriteFilesInput,
  WriteFilesResult,
} from "./types.js";

const TEMP_FILE_ATTEMPTS = 3;

type PlannedStatus = "created" | "replaced" | "unchanged";

interface PreparedWriteTarget {
  path: string;
  content: string;
  sizeBytes: number;
  sha256: string;
  expected: FilesystemTargetState;
  plannedStatus: PlannedStatus;
  tempPath?: string;
}

export interface WriteFilesOperationSuccess {
  ok: true;
  result: WriteFilesResult;
}

export interface WriteFilesOperationFailure {
  ok: false;
  code: string;
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  recoverable: boolean;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  errnoCode?: string;
  result: WriteFilesResult;
}

export type WriteFilesOperationResult =
  | WriteFilesOperationSuccess
  | WriteFilesOperationFailure;

export async function executeWriteFilesOperation(
  input: WriteFilesInput,
  context?: ToolExecutionContext,
): Promise<WriteFilesOperationResult> {
  const authorities = await resolveMutationAuthorities(context);
  const preconditions = filesystemPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const prepared: PreparedWriteTarget[] = [];
  const seenPaths = new Set<string>();

  for (const file of input.files) {
    const lexicalPath = resolve(file.path);
    const lexicalState = await lstat(lexicalPath).catch(missingPath);
    if (lexicalState?.isSymbolicLink()) {
      return preparationFailure(
        "WRITE_TARGET_NOT_REGULAR_FILE",
        `write_files does not replace symbolic links: ${lexicalPath}`,
        "semantic",
        lexicalPath,
        file,
      );
    }

    const path = await canonicalizeAbsoluteFilesystemPath(lexicalPath);
    if (!mutationAuthoritiesOwnPath(authorities, path)) {
      return preparationFailure(
        "PATH_OUTSIDE_SELECTED_MUTATION_ROOT",
        `write_files target is outside the selected absolute destination roots ${describeMutationAuthorities(authorities)}: ${path}`,
        "permission",
        path,
        file,
      );
    }
    if (seenPaths.has(path)) {
      return preparationFailure(
        "DUPLICATE_TARGET_PATH",
        `Multiple write_files entries resolve to the same canonical path: ${path}`,
        "conflict",
        path,
        file,
      );
    }
    seenPaths.add(path);

    const desiredSha256 = sha256(file.content);
    const expected = preconditions.get(path)
      ?? await observeFilesystemTarget(path);
    if (
      expected.kind === "directory"
      || expected.kind === "symlink"
      || expected.kind === "other"
    ) {
      return preparationFailure(
        "WRITE_TARGET_NOT_REGULAR_FILE",
        `write_files target must be missing or a regular file; observed ${expected.kind}: ${path}`,
        "semantic",
        path,
        file,
        expected.kind,
      );
    }

    const plannedStatus: PlannedStatus = expected.kind === "missing"
      ? "created"
      : expected.sha256 === desiredSha256
        ? "unchanged"
        : "replaced";
    if (
      plannedStatus === "replaced"
      && expected.kind === "file"
      && expected.linkCount > 1
    ) {
      return preparationFailure(
        "WRITE_HARDLINK_UNSUPPORTED",
        `write_files will not atomically replace a file with ${expected.linkCount} hard links: ${path}`,
        "semantic",
        path,
        file,
        { linkCount: expected.linkCount },
      );
    }

    prepared.push({
      path,
      content: file.content,
      sizeBytes: Buffer.byteLength(file.content, "utf-8"),
      sha256: desiredSha256,
      expected,
      plannedStatus,
    });
  }

  const createParents = input.createParents !== false;
  const changed = prepared.filter((target) => target.plannedStatus !== "unchanged");
  const parentDirectories = uniqueStrings(changed.map((target) => dirname(target.path)));

  if (!createParents) {
    for (const parent of parentDirectories) {
      const state = await lstat(parent).catch(missingPath);
      if (!state) {
        return operationFailure({
          prepared,
          code: "WRITE_PARENT_MISSING",
          message: `Parent directory does not exist: ${parent}`,
          category: "missing_path",
          target: parent,
          retryable: true,
        });
      }
      if (!state.isDirectory()) {
        return operationFailure({
          prepared,
          code: "WRITE_INVALID_PATH",
          message: `A parent path component is not a directory: ${parent}`,
          category: "semantic",
          target: parent,
          retryable: false,
        });
      }
    }
  } else {
    for (const parent of parentDirectories) {
      try {
        await mkdir(parent, { recursive: true });
      } catch (error) {
        return filesystemFailure(prepared, error, parent);
      }
    }
  }

  for (const target of changed) {
    try {
      target.tempPath = await stageTarget(target);
    } catch (error) {
      await cleanupTemporaryFiles(prepared);
      return filesystemFailure(prepared, error, target.path);
    }
  }

  for (const target of prepared) {
    const current = await observeFilesystemTarget(target.path);
    if (!sameFilesystemTargetState(target.expected, current)) {
      await cleanupTemporaryFiles(prepared);
      return operationFailure({
        prepared,
        code: "WRITE_CONFLICT",
        message: `Target changed while write_files was preparing its replacement: ${target.path}`,
        category: "conflict",
        target: target.path,
        expected: summarizeFilesystemTargetState(target.expected),
        actual: summarizeFilesystemTargetState(current),
        retryable: true,
      });
    }
  }

  const committed = new Map<string, WriteFileResult>();
  for (const target of changed) {
    try {
      await rename(requireTempPath(target), target.path);
      target.tempPath = undefined;
      committed.set(target.path, fileResult(target, target.plannedStatus));
    } catch (error) {
      await cleanupTemporaryFiles(prepared);
      const base = classifyWriteFilesystemError(error, target.path);
      return operationFailure({
        prepared,
        committed,
        code: committed.size > 0 ? "WRITE_PARTIAL" : base.code,
        message: committed.size > 0
          ? `${base.message} (${committed.size}/${changed.length} changed files were already committed)`
          : base.message,
        category: base.category,
        target: base.target,
        retryable: committed.size > 0 || base.retryable,
        recoverable: true,
        errnoCode: base.errnoCode,
      });
    }
  }

  return {
    ok: true,
    result: summarizeResults(prepared.map((target) => (
      target.plannedStatus === "unchanged"
        ? fileResult(target, "unchanged")
        : committed.get(target.path) ?? fileResult(target, "failed")
    ))),
  };
}

async function stageTarget(target: PreparedWriteTarget): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMP_FILE_ATTEMPTS; attempt += 1) {
    const tempPath = join(dirname(target.path), `.ayati-write-${randomUUID()}.tmp`);
    try {
      const handle = await open(tempPath, "wx", 0o666);
      try {
        await handle.writeFile(target.content, { encoding: "utf-8" });
        if (target.expected.kind === "file") {
          await handle.chmod(target.expected.mode);
        }
      } finally {
        await handle.close();
      }
      return tempPath;
    } catch (error) {
      lastError = error;
      await rm(tempPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw lastError ?? new Error(`Could not allocate a temporary file for ${target.path}.`);
}

async function cleanupTemporaryFiles(targets: PreparedWriteTarget[]): Promise<void> {
  await Promise.all(targets.flatMap((target) => (
    target.tempPath
      ? [rm(target.tempPath, { force: true }).catch(() => undefined)]
      : []
  )));
}

function requireTempPath(target: PreparedWriteTarget): string {
  if (!target.tempPath) {
    throw new Error(`Missing staged temporary file for ${target.path}.`);
  }
  return target.tempPath;
}

function preparationFailure(
  code: string,
  message: string,
  category: ToolErrorCategory,
  target: string,
  file: WriteFilesInput["files"][number],
  actual?: unknown,
): WriteFilesOperationFailure {
  const desired = fileResult({
    path: resolve(file.path),
    content: file.content,
    sizeBytes: Buffer.byteLength(file.content, "utf-8"),
    sha256: sha256(file.content),
    expected: { kind: "missing" },
    plannedStatus: "created",
  }, "failed", code, message);
  return {
    ok: false,
    code,
    message,
    category,
    retryable: code === "DUPLICATE_TARGET_PATH",
    recoverable: true,
    target,
    ...(actual !== undefined ? { actual } : {}),
    result: summarizeResults([desired]),
  };
}

function filesystemFailure(
  prepared: PreparedWriteTarget[],
  error: unknown,
  fallbackTarget: string,
): WriteFilesOperationFailure {
  const classified = classifyWriteFilesystemError(error, fallbackTarget);
  return operationFailure({
    prepared,
    code: classified.code,
    message: classified.message,
    category: classified.category,
    target: classified.target,
    retryable: classified.retryable,
    recoverable: true,
    errnoCode: classified.errnoCode,
  });
}

function operationFailure(input: {
  prepared: PreparedWriteTarget[];
  committed?: Map<string, WriteFileResult>;
  code: string;
  message: string;
  category: ToolErrorCategory;
  target?: string;
  retryable: boolean;
  recoverable?: boolean;
  expected?: unknown;
  actual?: unknown;
  errnoCode?: string;
}): WriteFilesOperationFailure {
  const committed = input.committed ?? new Map<string, WriteFileResult>();
  const files = input.prepared.map((target) => {
    const completed = committed.get(target.path);
    if (completed) return completed;
    if (target.plannedStatus === "unchanged") return fileResult(target, "unchanged");
    return fileResult(target, "failed", input.code, input.message);
  });
  return {
    ok: false,
    code: input.code,
    message: input.message,
    category: input.category,
    retryable: input.retryable,
    recoverable: input.recoverable ?? true,
    ...(input.target ? { target: input.target } : {}),
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
    ...(input.errnoCode ? { errnoCode: input.errnoCode } : {}),
    result: summarizeResults(files),
  };
}

export function classifyWriteFilesystemError(
  error: unknown,
  fallbackTarget: string,
): {
  code: string;
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  target: string;
  errnoCode?: string;
} {
  const errno = error as NodeJS.ErrnoException;
  const target = typeof errno.path === "string" ? errno.path : fallbackTarget;
  const detail = error instanceof Error ? error.message : "Unknown filesystem write error.";
  switch (errno.code) {
    case "EACCES":
    case "EPERM":
      return {
        code: "WRITE_PERMISSION_DENIED",
        message: `Permission denied while writing ${target}: ${detail}`,
        category: "permission",
        retryable: false,
        target,
        errnoCode: errno.code,
      };
    case "EROFS":
      return {
        code: "WRITE_READ_ONLY_FILESYSTEM",
        message: `The destination filesystem is read-only: ${target}`,
        category: "permission",
        retryable: false,
        target,
        errnoCode: errno.code,
      };
    case "ENOSPC":
    case "EDQUOT":
      return {
        code: "WRITE_STORAGE_FULL",
        message: `The destination has insufficient storage for ${target}.`,
        category: "transient",
        retryable: true,
        target,
        errnoCode: errno.code,
      };
    case "ENOENT":
      return {
        code: "WRITE_PARENT_MISSING",
        message: `A required parent path does not exist: ${target}`,
        category: "missing_path",
        retryable: true,
        target,
        errnoCode: errno.code,
      };
    case "ENOTDIR":
      return {
        code: "WRITE_INVALID_PATH",
        message: `A path component is not a directory: ${target}`,
        category: "semantic",
        retryable: false,
        target,
        errnoCode: errno.code,
      };
    case "EMFILE":
    case "ENFILE":
    case "EBUSY":
      return {
        code: "WRITE_TEMPORARY_FAILURE",
        message: `The filesystem is temporarily unavailable for ${target}: ${detail}`,
        category: "transient",
        retryable: true,
        target,
        errnoCode: errno.code,
      };
    default:
      return {
        code: "WRITE_FAILED",
        message: detail,
        category: "unknown",
        retryable: false,
        target,
        ...(errno.code ? { errnoCode: errno.code } : {}),
      };
  }
}

function fileResult(
  target: PreparedWriteTarget,
  status: WriteFileResult["status"],
  errorCode?: string,
  errorMessage?: string,
): WriteFileResult {
  return {
    path: target.path,
    status,
    sizeBytes: target.sizeBytes,
    sha256: target.sha256,
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function summarizeResults(files: WriteFileResult[]): WriteFilesResult {
  const filesChanged = files.filter((file) => (
    file.status === "created" || file.status === "replaced"
  ));
  return {
    filesRequested: files.length,
    filesChanged: filesChanged.length,
    filesUnchanged: files.filter((file) => file.status === "unchanged").length,
    filesFailed: files.filter((file) => file.status === "failed").length,
    bytesWritten: filesChanged.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function missingPath(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
