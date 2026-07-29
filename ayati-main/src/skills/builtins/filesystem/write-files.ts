import type {
  ArtifactRef,
  ToolDefinition,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import type { WriteFilesResult } from "./types.js";
import {
  MAX_WRITE_FILES,
  MAX_WRITE_TOTAL_BYTES,
  validateWriteFilesInput,
} from "./validators.js";
import {
  executeWriteFilesOperation,
  type WriteFilesOperationFailure,
} from "./write-files-operation.js";

export const writeFilesTool: ToolDefinition = {
  name: "write_files",
  description: "Make one or more UTF-8 text files match the requested content. Each file replacement is atomic, already-current files succeed unchanged, and a partially completed call can be retried safely.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_WRITE_FILES,
        description: `One to ${MAX_WRITE_FILES} files whose combined UTF-8 content is at most ${MAX_WRITE_TOTAL_BYTES} bytes.`,
        items: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: {
              type: "string",
              description: "File path relative to context.run.workspaceRoot, or a canonical absolute path inside the selected destination root.",
            },
            content: {
              type: "string",
              description: "Complete desired UTF-8 file content.",
            },
          },
          additionalProperties: false,
        },
      },
      createParents: {
        type: "boolean",
        description: "Create missing parent directories. Defaults to true.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: [
      "filesRequested",
      "filesChanged",
      "filesUnchanged",
      "filesFailed",
      "bytesWritten",
      "files",
    ],
    properties: {
      filesRequested: { type: "integer" },
      filesChanged: { type: "integer" },
      filesUnchanged: { type: "integer" },
      filesFailed: { type: "integer" },
      bytesWritten: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "status", "sizeBytes", "sha256"],
          properties: {
            path: { type: "string" },
            status: {
              type: "string",
              enum: ["created", "replaced", "unchanged", "failed"],
            },
            sizeBytes: { type: "integer" },
            sha256: { type: "string" },
            errorCode: { type: "string" },
            errorMessage: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
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
    artifacts: [
      { kind: "file", path: "$.result.structuredContent.files[*].path" },
    ],
  },
  errorContract: {
    codes: {
      WRITE_INPUT_LIMIT_EXCEEDED: recoverableError("validation", false),
      WRITE_INPUT_INVALID: recoverableError("validation", true),
      DUPLICATE_TARGET_PATH: recoverableError("conflict", true),
      PATH_OUTSIDE_SELECTED_MUTATION_ROOT: recoverableError("permission", false),
      WRITE_PARENT_MISSING: recoverableError("missing_path", true),
      WRITE_CONFLICT: recoverableError("conflict", true),
      WRITE_TARGET_NOT_REGULAR_FILE: recoverableError("semantic", false),
      WRITE_HARDLINK_UNSUPPORTED: recoverableError("semantic", false),
      WRITE_PERMISSION_DENIED: recoverableError("permission", false),
      WRITE_READ_ONLY_FILESYSTEM: recoverableError("permission", false),
      WRITE_STORAGE_FULL: recoverableError("transient", true),
      WRITE_INVALID_PATH: recoverableError("semantic", false),
      WRITE_TEMPORARY_FAILURE: recoverableError("transient", true),
      WRITE_PARTIAL: recoverableError("conflict", true),
      WRITE_FAILED: recoverableError("unknown", false),
    },
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateWriteFilesInput(input);
    if ("ok" in parsed) return normalizeValidationFailure(parsed);

    const start = Date.now();
    const operation = await executeWriteFilesOperation(parsed, context);
    const durationMs = Date.now() - start;
    if (!operation.ok) {
      return failureResult(operation, durationMs);
    }

    const code = operation.result.filesChanged === 0
      ? "FILES_ALREADY_CURRENT"
      : "FILES_APPLIED";
    const message = successMessage(operation.result);
    return {
      ok: true,
      output: JSON.stringify(operation.result, null, 2),
      meta: resultDiagnostics(operation.result, durationMs),
      v2: {
        transportOk: true,
        operationStatus: "succeeded",
        code,
        message,
        structuredContent: operation.result,
        artifacts: successfulArtifacts(operation.result),
        diagnostics: resultDiagnostics(operation.result, durationMs),
      },
    };
  },
};

function failureResult(
  failure: WriteFilesOperationFailure,
  durationMs: number,
): ToolResult {
  const operationStatus = failure.result.filesChanged > 0 ? "partial" : "failed";
  const error: ToolStructuredError = {
    category: failure.category,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    recoverable: failure.recoverable,
    ...(failure.target ? { target: failure.target } : {}),
    ...(failure.expected !== undefined ? { expected: failure.expected } : {}),
    ...(failure.actual !== undefined ? { actual: failure.actual } : {}),
    suggestedNextActions: suggestedNextActions(failure),
  };
  const diagnostics = {
    ...resultDiagnostics(failure.result, durationMs),
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
  const message = result.error ?? "Invalid write_files input.";
  const isLimit = message.includes("at most") || message.includes("UTF-8 bytes");
  const code = isLimit ? "WRITE_INPUT_LIMIT_EXCEEDED" : "WRITE_INPUT_INVALID";
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
        retryable: true,
        recoverable: true,
        suggestedNextActions: [
          isLimit
            ? "Reduce the number or total UTF-8 size of files in this call."
            : "Correct the write_files input and retry.",
        ],
      },
    },
  };
}

function resultDiagnostics(
  result: WriteFilesResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    durationMs,
    filesRequested: result.filesRequested,
    filesChanged: result.filesChanged,
    filesUnchanged: result.filesUnchanged,
    filesFailed: result.filesFailed,
    bytesWritten: result.bytesWritten,
  };
}

function successfulArtifacts(result: WriteFilesResult): ArtifactRef[] {
  return result.files.flatMap((file) => (
    file.status === "failed"
      ? []
      : [{
          kind: "file" as const,
          path: file.path,
          label: file.path,
          metadata: {
            status: file.status,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          },
        }]
  ));
}

function successMessage(result: WriteFilesResult): string {
  if (result.filesChanged === 0) {
    return `${result.filesUnchanged} file${result.filesUnchanged === 1 ? " is" : "s are"} already at the requested content.`;
  }
  const unchanged = result.filesUnchanged > 0
    ? `; ${result.filesUnchanged} already current`
    : "";
  return `Applied requested content to ${result.filesChanged} file${result.filesChanged === 1 ? "" : "s"}${unchanged}.`;
}

function suggestedNextActions(failure: WriteFilesOperationFailure): string[] {
  if (failure.code === "WRITE_PARTIAL") {
    return [
      "Retry the same write_files call; committed files will be reported unchanged and remaining files can complete.",
    ];
  }
  if (failure.code === "WRITE_CONFLICT") {
    return [
      "Inspect the current target content, rebuild the desired content if necessary, and retry.",
    ];
  }
  if (failure.code === "WRITE_PARENT_MISSING") {
    return [
      "Retry with createParents=true or create the intended parent directory first.",
    ];
  }
  if (failure.code === "DUPLICATE_TARGET_PATH") {
    return [
      "Keep only one entry for each canonical absolute target path.",
    ];
  }
  return [
    failure.retryable
      ? "Resolve the reported filesystem condition and retry the same desired-state write."
      : "Inspect the reported target and choose a supported regular-file destination.",
  ];
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
        ? "Resolve the reported condition and retry."
        : "Inspect the target and choose a supported write.",
    ],
  };
}
