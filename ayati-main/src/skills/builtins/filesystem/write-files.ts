import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition, ToolResult, ToolResultV2 } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { MAX_WRITE_FILES, validateWriteFilesInput } from "./validators.js";

interface PreparedWrite {
  requestedPath: string;
  filePath: string;
  tempPath: string;
  content: string;
  baseSha256?: string;
}

interface MovedWrite {
  requestedPath: string;
  filePath: string;
  bytesWritten: number;
  sha256: string;
  previousSha256?: string;
}

export const writeFilesTool: ToolDefinition = {
  name: "write_files",
  description: "Write multiple files as one serialized batch. New files can be created directly; overwriting an existing file requires files[].baseSha256 from a recent read result.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_WRITE_FILES,
        description: `Files to write. Use up to ${MAX_WRITE_FILES} files per call; split larger writes into another write_files call.`,
        items: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: {
              type: "string",
              description: "Absolute file path inside one mutable filesystem resource bound to the active workstream.",
            },
            content: { type: "string", description: "Content to write." },
            baseSha256: {
              type: "string",
              description: "Required when overwriting an existing file. Use the sha256 returned by a recent full read of the same file.",
            },
          },
          additionalProperties: false,
        },
      },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist (default: false).",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["filesWritten", "totalBytes", "files"],
    properties: {
      filesWritten: { type: "integer" },
      totalBytes: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["requestedPath", "filePath", "bytesWritten", "sha256"],
          properties: {
            requestedPath: { type: "string" },
            filePath: { type: "string" },
            bytesWritten: { type: "integer" },
            sha256: { type: "string" },
            previousSha256: { type: "string" },
          },
        },
      },
    },
  },
  annotations: {
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    mutatesExternalWorld: false,
    destructive: false,
    idempotent: true,
    retrySafe: true,
    longRunning: false,
  },
  resultContract: {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      { id: "operation_succeeded", kind: "tool_status", status: "succeeded" },
      {
        id: "files_written_matches_request",
        kind: "json_path_count_equals",
        path: "$.result.structuredContent.files",
        equalsPath: "$.input.files",
      },
      {
        id: "written_paths_exist",
        kind: "all_paths_exist",
        path: "$.result.structuredContent.files[*].filePath",
      },
      {
        id: "written_hashes_match",
        kind: "written_hashes_match",
        outputFilesPath: "$.result.structuredContent.files[*]",
        inputFilesPath: "$.input.files[*]",
      },
    ],
    artifacts: [
      { kind: "file", path: "$.result.structuredContent.files[*].filePath" },
    ],
    progressFacts: [
      {
        kind: "file_written",
        path: "$.result.structuredContent.files[*].filePath",
        message: "File written by write_files.",
      },
    ],
  },
  errorContract: {
    codes: {
      DUPLICATE_TARGET_PATH: {
        category: "conflict",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Remove duplicate target paths from files and retry."],
      },
      PARENT_DIR_MISSING: {
        category: "missing_path",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Retry write_files with createDirs=true or create the parent directory first."],
      },
      EXISTING_FILE_REQUIRES_BASE_SHA256: {
        category: "conflict",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Read the full current file first, then retry write_files with files[].baseSha256 from that read result."],
      },
      WRITE_PRECONDITION_FAILED: {
        category: "conflict",
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Re-read the current file, rebuild the complete replacement from that content, then retry with the new baseSha256."],
      },
      BATCH_WRITE_FAILED: {
        category: "unknown",
        retryable: false,
        recoverable: true,
        suggestedNextActions: ["Inspect diagnostics and retry only after resolving the filesystem error."],
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "write", "create", "file", "batch"],
    aliases: ["save_files", "overwrite_files", "batch_write_files"],
    examples: ["write multiple generated files", "save view.html and script.js together"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateWriteFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const prepared: PreparedWrite[] = [];
    const seenPaths = new Set<string>();

    for (const file of parsed.files) {
      const resolved = resolveWorkspaceMutationPath(file.path, {
        allowExternalPath: parsed.allowExternalPath,
        operation: "write_files",
        root: context?.resourceScope?.rootPath,
      });
      if (!resolved.ok) return externalWorkspacePathError(resolved);

      const filePath = resolved.path;
      if (seenPaths.has(filePath)) {
        const durationMs = Date.now() - start;
        const message = `Duplicate target path in batch: ${filePath}`;
        return {
          ok: false,
          error: message,
          meta: { durationMs, filePath },
          v2: {
            transportOk: true,
            operationStatus: "failed",
            code: "DUPLICATE_TARGET_PATH",
            message,
            structuredContent: {
              filesRequested: parsed.files.length,
              duplicatePath: filePath,
            },
            error: {
              category: "conflict",
              code: "DUPLICATE_TARGET_PATH",
              message,
              retryable: true,
              recoverable: true,
              target: filePath,
              suggestedNextActions: ["Remove duplicate target paths from files and retry."],
            },
            diagnostics: { durationMs, filePath },
          },
        };
      }
      seenPaths.add(filePath);
      prepared.push({
        requestedPath: file.path,
        filePath,
        tempPath: buildTempPath(filePath),
        content: file.content,
        ...(file.baseSha256 ? { baseSha256: file.baseSha256 } : {}),
      });
    }

    const tempPaths: string[] = [];
    const moved: MovedWrite[] = [];

    try {
      const parentDirs = [...new Set(prepared.map((file) => dirname(file.filePath)))];
      if (parsed.createDirs) {
        for (const dir of parentDirs) {
          await mkdir(dir, { recursive: true });
        }
      }

      const preconditions = await verifyExistingFilePreconditions(prepared, start);
      if (!preconditions.ok) {
        return preconditions.result;
      }

      for (const file of prepared) {
        await writeFile(file.tempPath, file.content, "utf-8");
        tempPaths.push(file.tempPath);
      }

      const finalPreconditions = await verifyExistingFilePreconditions(prepared, start);
      if (!finalPreconditions.ok) {
        throw new GuardedWritePreconditionError(finalPreconditions.result);
      }

      for (const file of prepared) {
        await rename(file.tempPath, file.filePath);
        moved.push({
          requestedPath: file.requestedPath,
          filePath: file.filePath,
          bytesWritten: Buffer.byteLength(file.content, "utf-8"),
          sha256: sha256Text(file.content),
          ...(file.baseSha256 ? { previousSha256: file.baseSha256 } : {}),
        });
      }

      const totalBytes = moved.reduce((sum, file) => sum + file.bytesWritten, 0);
      const structuredContent = {
        filesWritten: moved.length,
        totalBytes,
        files: moved,
      };
      const durationMs = Date.now() - start;
      return {
        ok: true,
        output: JSON.stringify(structuredContent, null, 2),
        meta: {
          durationMs,
          filesWritten: moved.length,
          totalBytes,
          files: moved,
        },
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "FILES_WRITTEN",
          message: `Wrote ${moved.length} file${moved.length === 1 ? "" : "s"}.`,
          structuredContent,
          artifacts: moved.map((file) => ({
            kind: "file",
            path: file.filePath,
            label: file.requestedPath,
            metadata: {
              bytesWritten: file.bytesWritten,
              sha256: file.sha256,
            },
          })),
          diagnostics: {
            durationMs,
            filesWritten: moved.length,
            totalBytes,
          },
        },
      };
    } catch (err) {
      await Promise.all(
        tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)),
      );
      if (err instanceof GuardedWritePreconditionError) {
        return err.result;
      }
      const message = err instanceof Error ? err.message : "Unknown filesystem batch write error";
      const durationMs = Date.now() - start;
      const v2 = buildFailureResult(message, err, parsed.createDirs === true, prepared, moved, durationMs);
      return {
        ok: false,
        error: moved.length > 0
          ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
          : message,
        meta: {
          durationMs,
          filesRequested: prepared.length,
          filesWritten: moved.length,
          partial: moved.length > 0,
          files: moved,
        },
        v2,
      };
    }
  },
};

function buildTempPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function verifyExistingFilePreconditions(
  prepared: PreparedWrite[],
  start: number,
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  for (const file of prepared) {
    const existing = await inspectExistingTarget(file.filePath);
    if (existing.status === "missing") {
      if (file.baseSha256) {
        return {
          ok: false,
          result: preconditionFailure({
            code: "WRITE_PRECONDITION_FAILED",
            message: `write_files precondition failed for ${file.filePath}: expected baseSha256 ${file.baseSha256}, but the file does not exist.`,
            target: file.filePath,
            expected: file.baseSha256,
            actual: "missing",
            file,
            filesRequested: prepared.length,
            durationMs: Date.now() - start,
          }),
        };
      }
      continue;
    }

    if (existing.status === "not_file") {
      return {
        ok: false,
        result: preconditionFailure({
          code: "WRITE_PRECONDITION_FAILED",
          message: `write_files precondition failed for ${file.filePath}: target exists but is not a regular file.`,
          target: file.filePath,
          expected: "regular file",
          actual: existing.kind,
          file,
          filesRequested: prepared.length,
          durationMs: Date.now() - start,
        }),
      };
    }

    if (!file.baseSha256) {
      return {
        ok: false,
        result: preconditionFailure({
          code: "EXISTING_FILE_REQUIRES_BASE_SHA256",
          message: `write_files refused to overwrite existing file without baseSha256: ${file.filePath}`,
          target: file.filePath,
          expected: "files[].baseSha256",
          actual: "missing",
          file,
          actualSha256: existing.sha256,
          filesRequested: prepared.length,
          durationMs: Date.now() - start,
        }),
      };
    }

    if (existing.sha256.toLowerCase() !== file.baseSha256.toLowerCase()) {
      return {
        ok: false,
        result: preconditionFailure({
          code: "WRITE_PRECONDITION_FAILED",
          message: `write_files precondition failed for ${file.filePath}: file changed since the baseSha256 was read.`,
          target: file.filePath,
          expected: file.baseSha256,
          actual: existing.sha256,
          file,
          actualSha256: existing.sha256,
          filesRequested: prepared.length,
          durationMs: Date.now() - start,
        }),
      };
    }
  }
  return { ok: true };
}

async function inspectExistingTarget(filePath: string): Promise<
  | { status: "missing" }
  | { status: "not_file"; kind: string }
  | { status: "file"; sha256: string }
> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { status: "not_file", kind: info.isDirectory() ? "directory" : "non-file" };
    }
    return { status: "file", sha256: sha256Text(await readFile(filePath, "utf-8")) };
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
}

function preconditionFailure(input: {
  code: "EXISTING_FILE_REQUIRES_BASE_SHA256" | "WRITE_PRECONDITION_FAILED";
  message: string;
  target: string;
  expected: unknown;
  actual: unknown;
  file: PreparedWrite;
  filesRequested: number;
  durationMs: number;
  actualSha256?: string;
}): ToolResult {
  const structuredContent = {
    filesRequested: input.filesRequested,
    filesWritten: 0,
    target: input.target,
    requestedPath: input.file.requestedPath,
    baseSha256: input.file.baseSha256,
    actualSha256: input.actualSha256,
  };
  const suggestedNextActions = input.code === "EXISTING_FILE_REQUIRES_BASE_SHA256"
    ? ["Read the full current file first, then retry write_files with files[].baseSha256 from that read result."]
    : ["Re-read the current file, rebuild the complete replacement from that content, then retry with the new baseSha256."];

  return {
    ok: false,
    error: input.message,
    meta: {
      durationMs: input.durationMs,
      filePath: input.target,
      filesRequested: input.filesRequested,
      filesWritten: 0,
    },
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code: input.code,
      message: input.message,
      structuredContent,
      error: {
        category: "conflict",
        code: input.code,
        message: input.message,
        retryable: true,
        recoverable: true,
        target: input.target,
        expected: input.expected,
        actual: input.actual,
        suggestedNextActions,
      },
      diagnostics: {
        durationMs: input.durationMs,
        filePath: input.target,
        filesRequested: input.filesRequested,
        filesWritten: 0,
        expected: input.expected,
        actual: input.actual,
      },
    },
  };
}

class GuardedWritePreconditionError extends Error {
  constructor(readonly result: ToolResult) {
    super(result.error ?? "write_files precondition failed.");
  }
}

function buildFailureResult(
  message: string,
  err: unknown,
  createDirs: boolean,
  prepared: PreparedWrite[],
  moved: MovedWrite[],
  durationMs: number,
): ToolResultV2 {
  const errno = err as NodeJS.ErrnoException;
  const parentTarget = prepared.length > 0 ? dirname(prepared[0]!.filePath) : undefined;
  const parentMissing = errno.code === "ENOENT" && !createDirs;
  const code = parentMissing ? "PARENT_DIR_MISSING" : "BATCH_WRITE_FAILED";
  const operationStatus = moved.length > 0 ? "partial" : "failed";
  const target = typeof errno.path === "string" ? errno.path : parentTarget;

  return {
    transportOk: true,
    operationStatus,
    code,
    message: moved.length > 0
      ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
      : message,
    structuredContent: {
      filesRequested: prepared.length,
      filesWritten: moved.length,
      partial: moved.length > 0,
      files: moved,
    },
    artifacts: moved.map((file) => ({
      kind: "file",
      path: file.filePath,
      label: file.requestedPath,
      metadata: { bytesWritten: file.bytesWritten, sha256: file.sha256 },
    })),
    error: {
      category: parentMissing ? "missing_path" : "unknown",
      code,
      message,
      retryable: parentMissing,
      recoverable: true,
      ...(target ? { target } : {}),
      suggestedNextActions: parentMissing
        ? ["Retry write_files with createDirs=true or create the missing parent directory first."]
        : ["Inspect diagnostics and retry only after resolving the filesystem error."],
    },
    diagnostics: {
      durationMs,
      filesRequested: prepared.length,
      filesWritten: moved.length,
      partial: moved.length > 0,
      errnoCode: errno.code,
    },
  };
}
