import type {
  ArtifactRef,
  ToolDefinition,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import {
  commonAnnotations,
  successV2,
} from "../contract-helpers.js";
import {
  executePatchFilesOperation,
  MAX_PATCH_TARGET_BYTES,
  MAX_PATCH_TOTAL_TARGET_BYTES,
  type PatchFilesOperationFailure,
} from "./patch-files-operation.js";
import type {
  PatchFileResult,
  PatchFilesResult,
} from "./types.js";
import {
  MAX_PATCH_FILES,
  MAX_PATCHES_PER_FILE,
  MAX_PATCH_INPUT_BYTES,
  validatePatchFilesInput,
} from "./validators.js";

export const patchFilesTool: ToolDefinition = {
  name: "patch_files",
  description: "Apply deterministic exact text patches to one or more existing UTF-8 files. Targets must match current content; approximate matches are returned only as diagnostics.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PATCH_FILES,
        description: `One to ${MAX_PATCH_FILES} existing text files. Patch text is limited to ${MAX_PATCH_INPUT_BYTES} combined UTF-8 bytes; targets are limited to ${MAX_PATCH_TARGET_BYTES} bytes each and ${MAX_PATCH_TOTAL_TARGET_BYTES} bytes combined.`,
        items: {
          type: "object",
          required: ["path", "patches"],
          properties: {
            path: {
              type: "string",
              description: "Existing UTF-8 file path relative to context.run.workspaceRoot, or a canonical absolute path inside the selected destination root.",
            },
            patches: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PATCHES_PER_FILE,
              description: "Patches are applied sequentially to this file in the listed order.",
              items: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: [
                      "replace_text",
                      "replace_all_text",
                      "insert_before",
                      "insert_after",
                      "replace_lines",
                    ],
                  },
                  find: {
                    type: "string",
                    description: "Exact stable text target for replace_text or replace_all_text.",
                  },
                  replace: {
                    type: "string",
                    description: "Replacement text for replace_text, replace_all_text, or replace_lines.",
                  },
                  anchor: {
                    type: "string",
                    description: "Exact anchor text for insert_before or insert_after.",
                  },
                  content: {
                    type: "string",
                    description: "Content to insert before or after the exact anchor.",
                  },
                  startLine: {
                    type: "integer",
                    minimum: 1,
                    description: "Current 1-based start line for replace_lines.",
                  },
                  endLine: {
                    anyOf: [
                      { type: "integer", minimum: 1 },
                      { type: "string", enum: ["EOF"] },
                    ],
                    description: "Current 1-based inclusive end line, or \"EOF\".",
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: [
      "filesRequested",
      "filesPatched",
      "filesFailed",
      "patchesApplied",
      "changesApplied",
      "totalBytes",
      "files",
    ],
    properties: {
      filesRequested: { type: "integer" },
      filesPatched: { type: "integer" },
      filesFailed: { type: "integer" },
      patchesApplied: { type: "integer" },
      changesApplied: { type: "integer" },
      totalBytes: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: [
            "requestedPath",
            "filePath",
            "status",
            "patchesApplied",
            "changesApplied",
            "bytesWritten",
            "checks",
          ],
          properties: {
            requestedPath: { type: "string" },
            filePath: { type: "string" },
            status: {
              type: "string",
              enum: ["patched", "failed"],
            },
            patchesApplied: { type: "integer" },
            changesApplied: { type: "integer" },
            bytesWritten: { type: "integer" },
            sha256: { type: "string" },
            checks: { type: "array" },
            errorCode: { type: "string" },
            errorMessage: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    idempotent: false,
    retrySafe: false,
  }),
  resultContract: {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      {
        id: "operation_succeeded",
        kind: "tool_status",
        status: "succeeded",
      },
      {
        id: "files_result_matches_request",
        kind: "json_path_count_equals",
        path: "$.result.structuredContent.files",
        equalsPath: "$.input.files",
      },
      {
        id: "files_requested_matches_request",
        kind: "json_path_number_equals_count",
        path: "$.result.structuredContent.filesRequested",
        equalsPath: "$.input.files",
      },
    ],
    artifacts: [{
      kind: "file",
      path: "$.result.structuredContent.files[*].filePath",
    }],
    progressFacts: [{
      kind: "file_patched",
      path: "$.result.structuredContent.files[*].filePath",
      message: "File patched by patch_files.",
    }],
  },
  errorContract: {
    codes: {
      PATCH_INPUT_INVALID: recoverableError("validation", true),
      PATCH_INPUT_LIMIT_EXCEEDED: recoverableError("validation", false),
      DUPLICATE_TARGET_PATH: recoverableError("conflict", true),
      PATH_OUTSIDE_SELECTED_MUTATION_ROOT: recoverableError("permission", false),
      PATCH_FILE_NOT_FOUND: recoverableError("missing_path", true),
      PATCH_TARGET_NOT_FOUND: recoverableError("semantic", true),
      PATCH_TARGET_NOT_REGULAR_FILE: recoverableError("semantic", false),
      PATCH_TARGET_TOO_LARGE: recoverableError("validation", false),
      PATCH_TOTAL_TARGET_BYTES_EXCEEDED: recoverableError("validation", false),
      PATCH_OUTPUT_TOO_LARGE: recoverableError("validation", false),
      PATCH_TOTAL_OUTPUT_BYTES_EXCEEDED: recoverableError("validation", false),
      PATCH_INVALID_UTF8: recoverableError("semantic", false),
      PATCH_HARDLINK_UNSUPPORTED: recoverableError("semantic", false),
      PATCH_TARGET_AMBIGUOUS: recoverableError("semantic", true),
      PATCH_NO_CHANGE: recoverableError("semantic", true),
      PATCH_CONFLICT: recoverableError("conflict", true),
      PATCH_PERMISSION_DENIED: recoverableError("permission", false),
      PATCH_READ_ONLY_FILESYSTEM: recoverableError("permission", false),
      PATCH_STORAGE_FULL: recoverableError("transient", true),
      PATCH_INVALID_PATH: recoverableError("semantic", false),
      PATCH_TEMPORARY_FAILURE: recoverableError("transient", true),
      PATCH_PARTIAL: recoverableError("conflict", false),
      PATCH_WRITE_FAILED: recoverableError("unknown", false),
    },
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validatePatchFilesInput(input);
    if ("ok" in parsed) return normalizeValidationFailure(parsed);

    const start = Date.now();
    const operation = await executePatchFilesOperation(parsed, context);
    const durationMs = Date.now() - start;
    if (!operation.ok) {
      return failureResult(operation, durationMs);
    }

    const diagnostics = resultDiagnostics(operation.result, durationMs);
    return {
      ok: true,
      output: JSON.stringify(operation.result, null, 2),
      meta: diagnostics,
      v2: successV2({
        code: "FILES_PATCHED",
        message: `Patched ${operation.result.filesPatched} file${operation.result.filesPatched === 1 ? "" : "s"} with ${operation.result.patchesApplied} patch${operation.result.patchesApplied === 1 ? "" : "es"}.`,
        structuredContent: operation.result,
        artifacts: successfulArtifacts(operation.result),
        diagnostics,
      }),
    };
  },
};

function failureResult(
  failure: PatchFilesOperationFailure,
  durationMs: number,
): ToolResult {
  const operationStatus = failure.result.filesPatched > 0
    ? "partial"
    : "failed";
  const error: ToolStructuredError = {
    category: failure.category,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    recoverable: failure.recoverable,
    ...(failure.target ? { target: failure.target } : {}),
    ...(failure.expected !== undefined
      ? { expected: failure.expected }
      : {}),
    ...(failure.actual !== undefined ? { actual: failure.actual } : {}),
    suggestedNextActions: failure.suggestedNextActions,
  };
  const diagnostics = {
    ...resultDiagnostics(failure.result, durationMs),
    ...(failure.patchIndex !== undefined
      ? { patchIndex: failure.patchIndex }
      : {}),
    ...(failure.patchKind ? { patchKind: failure.patchKind } : {}),
    ...(failure.diagnostic !== undefined
      ? { diagnostic: failure.diagnostic }
      : {}),
    ...(failure.errnoCode ? { errnoCode: failure.errnoCode } : {}),
  };
  return {
    ok: false,
    error: failure.message,
    meta: diagnostics,
    v2: {
      transportOk: true,
      operationStatus,
      code: failure.code,
      message: failure.message,
      structuredContent: failure.result,
      artifacts: successfulArtifacts(failure.result),
      error,
      diagnostics,
    },
  };
}

function normalizeValidationFailure(result: ToolResult): ToolResult {
  if (result.v2) return result;
  const message = result.error ?? "Invalid patch_files input.";
  const isLimit = message.includes("at most")
    || message.includes("maximum")
    || message.includes("UTF-8 bytes");
  const code = isLimit
    ? "PATCH_INPUT_LIMIT_EXCEEDED"
    : "PATCH_INPUT_INVALID";
  return {
    ...result,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      error: {
        category: "validation",
        code,
        message,
        retryable: !isLimit,
        recoverable: true,
        suggestedNextActions: [
          isLimit
            ? "Reduce the number or combined text size of patches in this call."
            : "Correct the patch_files input and retry.",
        ],
      },
    },
  };
}

function resultDiagnostics(
  result: PatchFilesResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    durationMs,
    filesRequested: result.filesRequested,
    filesPatched: result.filesPatched,
    filesFailed: result.filesFailed,
    patchesApplied: result.patchesApplied,
    changesApplied: result.changesApplied,
    totalBytes: result.totalBytes,
  };
}

function successfulArtifacts(result: PatchFilesResult): ArtifactRef[] {
  return result.files.flatMap((file) => (
    file.status === "patched"
      ? [{
          kind: "file" as const,
          path: file.filePath,
          label: file.requestedPath,
          metadata: fileMetadata(file),
        }]
      : []
  ));
}

function fileMetadata(file: PatchFileResult): Record<string, unknown> {
  return {
    status: file.status,
    patchesApplied: file.patchesApplied,
    changesApplied: file.changesApplied,
    bytesWritten: file.bytesWritten,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  };
}

function recoverableError(
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
    suggestedNextActions: [
      retryable
        ? "Resolve the reported condition, reread the target, and create a fresh exact patch."
        : "Inspect the reported target and choose a supported patch operation.",
    ],
  };
}
