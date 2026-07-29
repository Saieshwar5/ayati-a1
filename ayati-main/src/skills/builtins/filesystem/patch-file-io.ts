import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  canonicalizeAbsoluteFilesystemPath,
  filesystemPathIsWithin,
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
import { getWorkspaceRoot } from "../../workspace-paths.js";
import { classifyWriteFilesystemError } from "./write-files-operation.js";
import type { PatchCheck } from "./patch-text.js";
import type { PatchFilesInput } from "./types.js";

export const MAX_PATCH_TARGET_BYTES = 10 * 1024 * 1024;
export const MAX_PATCH_TOTAL_TARGET_BYTES = 20 * 1024 * 1024;

const TEMP_FILE_ATTEMPTS = 3;

export interface ResolvedPatchTarget {
  requestedPath: string;
  path: string;
  patches: PatchFilesInput["files"][number]["patches"];
}

export interface PreparedPatchTarget extends ResolvedPatchTarget {
  expected: Extract<FilesystemTargetState, { kind: "file" }>;
  content: string;
  sizeBytes: number;
  sha256: string;
  patchesApplied: number;
  changesApplied: number;
  checks: PatchCheck[];
  tempPath?: string;
}

export interface ObservedTextFile {
  state: Extract<FilesystemTargetState, { kind: "file" }>;
  content: string;
}

export interface PatchOperationIssue {
  code: string;
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  target: string;
  suggestedNextActions: string[];
  actual?: unknown;
  errnoCode?: string;
}

export async function resolvePatchTargets(
  input: PatchFilesInput,
  context?: ToolExecutionContext,
): Promise<
  | { ok: true; targets: ResolvedPatchTarget[] }
  | { ok: false; issue: PatchOperationIssue }
> {
  let authority: {
    path: string;
    kind: "file" | "directory";
  } | undefined;
  try {
    authority = await resolveAuthority(input, context);
  } catch (error) {
    return {
      ok: false,
      issue: classifyPatchFilesystemError(error, getWorkspaceRoot()),
    };
  }

  const targets: ResolvedPatchTarget[] = [];
  const seenPaths = new Set<string>();
  for (const file of input.files) {
    const lexicalPath = resolve(file.path);
    let lexicalState;
    try {
      lexicalState = await lstat(lexicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          issue: {
            code: "PATCH_FILE_NOT_FOUND",
            message: `Patch target does not exist: ${lexicalPath}`,
            category: "missing_path",
            retryable: true,
            target: lexicalPath,
            suggestedNextActions: [
              "Read or create the target file before retrying patch_files.",
            ],
          },
        };
      }
      return {
        ok: false,
        issue: classifyPatchFilesystemError(error, lexicalPath),
      };
    }
    if (lexicalState.isSymbolicLink()) {
      return {
        ok: false,
        issue: {
          code: "PATCH_TARGET_NOT_REGULAR_FILE",
          message: `patch_files does not replace symbolic links: ${lexicalPath}`,
          category: "semantic",
          retryable: false,
          target: lexicalPath,
          actual: "symlink",
          suggestedNextActions: ["Choose the regular file target explicitly."],
        },
      };
    }

    let path: string;
    try {
      path = await canonicalizeAbsoluteFilesystemPath(lexicalPath);
    } catch (error) {
      return {
        ok: false,
        issue: classifyPatchFilesystemError(error, lexicalPath),
      };
    }
    if (
      authority
      && !authorityOwnsPath(authority.path, authority.kind, path)
    ) {
      return {
        ok: false,
        issue: {
          code: "PATH_OUTSIDE_SELECTED_MUTATION_ROOT",
          message: `patch_files target is outside the selected absolute destination root ${authority.path}: ${path}`,
          category: "permission",
          retryable: false,
          target: path,
          suggestedNextActions: [
            "Choose a target inside the selected destination root.",
          ],
        },
      };
    }
    if (seenPaths.has(path)) {
      return {
        ok: false,
        issue: {
          code: "DUPLICATE_TARGET_PATH",
          message: `Multiple patch_files entries resolve to the same canonical path: ${path}`,
          category: "conflict",
          retryable: true,
          target: path,
          suggestedNextActions: [
            "Keep exactly one patch_files entry for each canonical target path.",
          ],
        },
      };
    }
    seenPaths.add(path);
    targets.push({
      requestedPath: file.path,
      path,
      patches: file.patches,
    });
  }

  return { ok: true, targets };
}

export function targetsForPatchFailure(
  input: PatchFilesInput,
): ResolvedPatchTarget[] {
  return input.files.map((file) => ({
    requestedPath: file.path,
    path: resolve(file.path),
    patches: file.patches,
  }));
}

export async function observePatchTextFile(
  path: string,
): Promise<
  | { ok: true; value: ObservedTextFile }
  | { ok: false; issue: PatchOperationIssue }
> {
  const info = await lstat(path).catch(missingPath);
  if (!info) {
    return {
      ok: false,
      issue: {
        code: "PATCH_FILE_NOT_FOUND",
        message: `Patch target does not exist: ${path}`,
        category: "missing_path",
        retryable: true,
        target: path,
        suggestedNextActions: [
          "Read or create the target file before retrying patch_files.",
        ],
      },
    };
  }
  if (!info.isFile()) {
    return {
      ok: false,
      issue: {
        code: "PATCH_TARGET_NOT_REGULAR_FILE",
        message: `Patch target must be a regular file: ${path}`,
        category: "semantic",
        retryable: false,
        target: path,
        actual: info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "directory"
            : "other",
        suggestedNextActions: ["Choose an existing regular UTF-8 text file."],
      },
    };
  }
  if (info.size > MAX_PATCH_TARGET_BYTES) {
    return {
      ok: false,
      issue: {
        code: "PATCH_TARGET_TOO_LARGE",
        message: `Patch target exceeds the ${MAX_PATCH_TARGET_BYTES}-byte per-file limit: ${path}`,
        category: "validation",
        retryable: false,
        target: path,
        actual: {
          sizeBytes: info.size,
          maximumBytes: MAX_PATCH_TARGET_BYTES,
        },
        suggestedNextActions: [
          "Use a specialized large-file transformation tool or split the source file.",
        ],
      },
    };
  }

  const bytes = await readFile(path);
  const content = bytes.toString("utf-8");
  if (!Buffer.from(content, "utf-8").equals(bytes)) {
    return {
      ok: false,
      issue: {
        code: "PATCH_INVALID_UTF8",
        message: `Patch target is not valid UTF-8 text: ${path}`,
        category: "semantic",
        retryable: false,
        target: path,
        suggestedNextActions: [
          "Use a binary-safe tool or convert the file to valid UTF-8 before patching.",
        ],
      },
    };
  }

  const currentInfo = await lstat(path).catch(missingPath);
  if (!currentInfo?.isFile()) {
    return {
      ok: false,
      issue: {
        code: "PATCH_CONFLICT",
        message: `Patch target changed while it was being read: ${path}`,
        category: "conflict",
        retryable: true,
        target: path,
        actual: currentInfo ? "non-file" : "missing",
        suggestedNextActions: [
          "Read the current target and retry with a new exact patch.",
        ],
      },
    };
  }

  return {
    ok: true,
    value: {
      state: {
        kind: "file",
        sizeBytes: bytes.length,
        sha256: sha256PatchContent(bytes),
        mode: currentInfo.mode & 0o777,
        linkCount: currentInfo.nlink,
        device: currentInfo.dev,
        inode: currentInfo.ino,
      },
      content,
    },
  };
}

export async function observePatchTargetState(
  path: string,
): Promise<FilesystemTargetState> {
  return await observeFilesystemTarget(path);
}

export async function stagePatchTarget(
  target: PreparedPatchTarget,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEMP_FILE_ATTEMPTS; attempt += 1) {
    const tempPath = join(
      dirname(target.path),
      `.ayati-patch-${randomUUID()}.tmp`,
    );
    try {
      const handle = await open(tempPath, "wx", 0o666);
      try {
        await handle.writeFile(target.content, { encoding: "utf-8" });
        await handle.chmod(target.expected.mode);
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
  throw lastError
    ?? new Error(`Could not allocate a temporary file for ${target.path}.`);
}

export async function cleanupPatchTemporaryFiles(
  targets: PreparedPatchTarget[],
): Promise<void> {
  await Promise.all(targets.flatMap((target) => (
    target.tempPath
      ? [rm(target.tempPath, { force: true }).catch(() => undefined)]
      : []
  )));
}

export function requirePatchTempPath(
  target: PreparedPatchTarget,
): string {
  if (!target.tempPath) {
    throw new Error(`Missing staged temporary file for ${target.path}.`);
  }
  return target.tempPath;
}

export function patchPreconditionMap(
  values: ToolExecutionContext["filesystemTargetPreconditions"],
): Map<string, FilesystemTargetState> {
  return filesystemPreconditionMap(values);
}

export {
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
};

export function sha256PatchContent(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyPatchFilesystemError(
  error: unknown,
  fallbackTarget: string,
): PatchOperationIssue {
  const base = classifyWriteFilesystemError(error, fallbackTarget);
  const mapping: Record<string, string> = {
    WRITE_PERMISSION_DENIED: "PATCH_PERMISSION_DENIED",
    WRITE_READ_ONLY_FILESYSTEM: "PATCH_READ_ONLY_FILESYSTEM",
    WRITE_STORAGE_FULL: "PATCH_STORAGE_FULL",
    WRITE_PARENT_MISSING: "PATCH_FILE_NOT_FOUND",
    WRITE_INVALID_PATH: "PATCH_INVALID_PATH",
    WRITE_TEMPORARY_FAILURE: "PATCH_TEMPORARY_FAILURE",
    WRITE_FAILED: "PATCH_WRITE_FAILED",
  };
  const code = mapping[base.code] ?? "PATCH_WRITE_FAILED";
  return {
    ...base,
    code,
    suggestedNextActions: patchFilesystemSuggestedActions(
      code,
      base.retryable,
    ),
  };
}

function patchFilesystemSuggestedActions(
  code: string,
  retryable: boolean,
): string[] {
  switch (code) {
    case "PATCH_FILE_NOT_FOUND":
      return ["Read the current target path before building a new patch."];
    case "PATCH_STORAGE_FULL":
      return [
        "Free destination storage, then retry after confirming the target is unchanged.",
      ];
    case "PATCH_TEMPORARY_FAILURE":
      return [
        "Retry after the temporary filesystem condition clears and the target is reread.",
      ];
    case "PATCH_PERMISSION_DENIED":
    case "PATCH_READ_ONLY_FILESYSTEM":
      return [
        "Choose a writable target or correct the operating-system permissions.",
      ];
    default:
      return [
        retryable
          ? "Resolve the reported condition, reread the target, and retry."
          : "Inspect the target and filesystem error before making another patch.",
      ];
  }
}

async function resolveAuthority(
  input: PatchFilesInput,
  context?: ToolExecutionContext,
): Promise<
  { path: string; kind: "file" | "directory" } | undefined
> {
  const scope = context?.resourceScope;
  if (!scope && input.allowExternalPath === true) return undefined;
  return {
    path: await canonicalizeAbsoluteFilesystemPath(
      scope?.authorityPath ?? getWorkspaceRoot(),
    ),
    kind: scope?.authorityKind ?? "directory",
  };
}

function authorityOwnsPath(
  authorityPath: string,
  authorityKind: "file" | "directory",
  path: string,
): boolean {
  return authorityKind === "file"
    ? resolve(authorityPath) === resolve(path)
    : filesystemPathIsWithin(authorityPath, path);
}

function missingPath(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
