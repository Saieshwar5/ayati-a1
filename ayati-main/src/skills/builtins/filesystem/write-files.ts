import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition, ToolResult, ToolResultV2 } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validateWriteFilesInput } from "./validators.js";

interface PreparedWrite {
  requestedPath: string;
  filePath: string;
  tempPath: string;
  content: string;
}

interface MovedWrite {
  requestedPath: string;
  filePath: string;
  bytesWritten: number;
  sha256: string;
}

export const writeFilesTool: ToolDefinition = {
  name: "write_files",
  description: "Write or overwrite multiple files as one serialized batch. Validates all paths first, writes temp files, then renames them into place.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative file path by default. Absolute paths outside the workspace require allowExternalPath=true.",
            },
            content: { type: "string", description: "Content to write." },
          },
          additionalProperties: false,
        },
      },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist (default: false).",
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow writing batch files to absolute paths outside the configured workspace. Use only when the user explicitly requested those external paths.",
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
  async execute(input): Promise<ToolResult> {
    const parsed = validateWriteFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const prepared: PreparedWrite[] = [];
    const seenPaths = new Set<string>();

    for (const file of parsed.files) {
      const resolved = resolveWorkspaceMutationPath(file.path, {
        allowExternalPath: parsed.allowExternalPath,
        operation: "write_files",
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

      for (const file of prepared) {
        await writeFile(file.tempPath, file.content, "utf-8");
        tempPaths.push(file.tempPath);
      }

      for (const file of prepared) {
        await rename(file.tempPath, file.filePath);
        moved.push({
          requestedPath: file.requestedPath,
          filePath: file.filePath,
          bytesWritten: Buffer.byteLength(file.content, "utf-8"),
          sha256: sha256Text(file.content),
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
