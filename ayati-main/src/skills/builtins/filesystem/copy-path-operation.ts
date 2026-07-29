import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { sha256File } from "../../../shared/filesystem-target-state.js";
import type { ToolErrorCategory } from "../../types.js";
import {
  classifyFilesystemOperationError,
  type FilesystemOperationIssue,
} from "./path-operation-helpers.js";

const TEMP_PATH_ATTEMPTS = 3;
const MAX_COPY_ENTRIES = 100_000;

export type CopiedPathKind = "file" | "directory" | "symlink";

export interface PathFingerprint {
  kind: CopiedPathKind;
  contentSha256: string;
  entryCount: number;
  totalBytes: number;
}

export interface StagedPathCopy {
  source: string;
  destination: string;
  tempPath: string;
  fingerprint: PathFingerprint;
}

export interface CopyPathDependencies {
  copyFile: typeof copyFile;
  copyDirectory: typeof cp;
  createSymlink: typeof symlink;
  rename: typeof rename;
  remove: typeof rm;
}

const DEFAULT_DEPENDENCIES: CopyPathDependencies = {
  copyFile,
  copyDirectory: cp,
  createSymlink: symlink,
  rename,
  remove: rm,
};

export class CopyPathOperationError extends Error {
  constructor(
    readonly issue: FilesystemOperationIssue,
  ) {
    super(issue.message);
  }
}

export async function stageVerifiedPathCopy(
  source: string,
  destination: string,
  prefix: "COPY" | "MOVE",
  dependencies: CopyPathDependencies = DEFAULT_DEPENDENCIES,
): Promise<StagedPathCopy> {
  const sourceBefore = await fingerprintPath(source, prefix);
  let lastError: unknown;

  for (let attempt = 0; attempt < TEMP_PATH_ATTEMPTS; attempt += 1) {
    const tempPath = join(
      dirname(destination),
      `.ayati-${prefix.toLowerCase()}-${randomUUID()}-${basename(destination)}`,
    );
    try {
      await copyIntoTemporaryPath(
        source,
        tempPath,
        sourceBefore.kind,
        dependencies,
      );
      const copied = await fingerprintPath(tempPath, prefix);
      if (!samePathFingerprint(sourceBefore, copied)) {
        throw new CopyPathOperationError({
          code: copyVerificationCode(prefix),
          message: `Staged ${sourceBefore.kind} copy does not match its source: ${source}`,
          category: "conflict",
          retryable: true,
          recoverable: true,
          target: tempPath,
          expected: sourceBefore,
          actual: copied,
        });
      }
      const sourceAfter = await fingerprintPath(source, prefix);
      if (!samePathFingerprint(sourceBefore, sourceAfter)) {
        throw new CopyPathOperationError({
          code: `${prefix}_SOURCE_CHANGED`,
          message: `Source changed while it was being copied: ${source}`,
          category: "conflict",
          retryable: true,
          recoverable: true,
          target: source,
          expected: sourceBefore,
          actual: sourceAfter,
        });
      }
      return {
        source,
        destination,
        tempPath,
        fingerprint: copied,
      };
    } catch (error) {
      lastError = error;
      await dependencies.remove(tempPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  throw lastError ?? new CopyPathOperationError({
    code: `${prefix}_TEMPORARY_FAILURE`,
    message: `Could not allocate a temporary destination beside ${destination}.`,
    category: "transient",
    retryable: true,
    recoverable: true,
    target: destination,
  });
}

function copyVerificationCode(prefix: "COPY" | "MOVE"): string {
  return prefix === "COPY"
    ? "COPY_VERIFICATION_FAILED"
    : "MOVE_COPY_VERIFICATION_FAILED";
}

export async function commitStagedPathCopy(
  staged: StagedPathCopy,
  dependencies: CopyPathDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  await dependencies.rename(staged.tempPath, staged.destination);
}

export async function cleanupStagedPathCopy(
  staged: StagedPathCopy | undefined,
  dependencies: CopyPathDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!staged) return;
  await dependencies.remove(staged.tempPath, {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

export async function fingerprintPath(
  root: string,
  prefix: "COPY" | "MOVE",
): Promise<PathFingerprint> {
  const hash = createHash("sha256");
  let entryCount = 0;
  let totalBytes = 0;
  let rootKind: CopiedPathKind | undefined;

  async function visit(path: string): Promise<void> {
    entryCount += 1;
    if (entryCount > MAX_COPY_ENTRIES) {
      throw new CopyPathOperationError({
        code: `${prefix}_ENTRY_LIMIT_EXCEEDED`,
        message: `Copy source contains more than ${MAX_COPY_ENTRIES} entries: ${root}`,
        category: "semantic",
        retryable: false,
        recoverable: true,
        target: root,
      });
    }

    const state = await lstat(path);
    const pathFromRoot = path === root
      ? "."
      : relative(root, path).split(sep).join("/");
    if (state.isFile()) {
      rootKind ??= "file";
      const contentSha256 = await sha256File(path);
      totalBytes += state.size;
      addManifestEntry(hash, {
        path: pathFromRoot,
        kind: "file",
        sizeBytes: state.size,
        mode: state.mode & 0o777,
        contentSha256,
      });
      return;
    }
    if (state.isSymbolicLink()) {
      rootKind ??= "symlink";
      addManifestEntry(hash, {
        path: pathFromRoot,
        kind: "symlink",
        linkTarget: await readlink(path),
      });
      return;
    }
    if (!state.isDirectory()) {
      throw new CopyPathOperationError({
        code: `${prefix}_UNSUPPORTED_SOURCE_KIND`,
        message: `Only files, directories, and symbolic links can be copied: ${path}`,
        category: "semantic",
        retryable: false,
        recoverable: true,
        target: path,
      });
    }

    rootKind ??= "directory";
    addManifestEntry(hash, {
      path: pathFromRoot,
      kind: "directory",
      mode: state.mode & 0o777,
    });
    const entries = await readdir(path);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await visit(join(path, entry));
    }
  }

  try {
    await visit(root);
  } catch (error) {
    if (error instanceof CopyPathOperationError) throw error;
    throw new CopyPathOperationError(
      classifyFilesystemOperationError(error, root, prefix),
    );
  }

  if (!rootKind) {
    throw new CopyPathOperationError({
      code: `${prefix}_SOURCE_NOT_FOUND`,
      message: `Copy source does not exist: ${root}`,
      category: "missing_path",
      retryable: true,
      recoverable: true,
      target: root,
    });
  }
  return {
    kind: rootKind,
    contentSha256: hash.digest("hex"),
    entryCount,
    totalBytes,
  };
}

function addManifestEntry(
  hash: ReturnType<typeof createHash>,
  entry: Record<string, unknown>,
): void {
  const value = JSON.stringify(entry);
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update(":");
  hash.update(value);
  hash.update("\n");
}

async function copyIntoTemporaryPath(
  source: string,
  tempPath: string,
  kind: CopiedPathKind,
  dependencies: CopyPathDependencies,
): Promise<void> {
  if (kind === "file") {
    await dependencies.copyFile(source, tempPath, constants.COPYFILE_EXCL);
    const sourceState = await lstat(source);
    await chmod(tempPath, sourceState.mode & 0o777);
    return;
  }
  if (kind === "symlink") {
    await dependencies.createSymlink(await readlink(source), tempPath);
    return;
  }
  await dependencies.copyDirectory(source, tempPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export function samePathFingerprint(
  left: PathFingerprint,
  right: PathFingerprint,
): boolean {
  return left.kind === right.kind
    && left.contentSha256 === right.contentSha256
    && left.entryCount === right.entryCount
    && left.totalBytes === right.totalBytes;
}

export function copyIssue(
  code: string,
  message: string,
  category: ToolErrorCategory,
  target: string,
  retryable = false,
): CopyPathOperationError {
  return new CopyPathOperationError({
    code,
    message,
    category,
    retryable,
    recoverable: true,
    target,
  });
}
