import { randomUUID } from "node:crypto";
import { rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  filesystemPreconditionMap,
  observeFilesystemTarget,
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  FilesystemTargetState,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import {
  classifyFilesystemOperationError,
  filesystemValidationFailure,
  recoverableFilesystemErrorContract,
  resolveContainedMutationPath,
  type FilesystemOperationIssue,
} from "./path-operation-helpers.js";
import type { DeleteInput, DeleteResult } from "./types.js";
import { validateDeleteInput } from "./validators.js";

const DELETE_STAGING_ATTEMPTS = 3;

export interface DeleteOperationDependencies {
  rename: typeof rename;
  remove: typeof rm;
  unlink: typeof unlink;
}

const DEFAULT_DEPENDENCIES: DeleteOperationDependencies = {
  rename,
  remove: rm,
  unlink,
};

export const deleteTool: ToolDefinition = {
  name: "delete",
  description: "Ensure one canonical absolute path is absent. Files and symbolic links are unlinked directly; recursive directories are first renamed to a private sibling so the requested path is never left half-deleted.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "File or directory path relative to context.run.workspaceRoot, or a canonical absolute path inside the selected destination root.",
      },
      recursive: {
        type: "boolean",
        description: "Required for directory deletion. Defaults to false.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "targetPath", "status", "deleted"],
    properties: {
      requestedPath: { type: "string" },
      targetPath: { type: "string" },
      kind: {
        type: "string",
        enum: ["file", "directory", "symlink"],
      },
      status: {
        type: "string",
        enum: ["deleted", "already_absent", "cleanup_pending", "failed"],
      },
      deleted: { type: "boolean" },
      cleanupPath: { type: "string" },
      errorCode: { type: "string" },
      errorMessage: { type: "string" },
    },
    additionalProperties: false,
  },
  annotations: {
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    mutatesExternalWorld: false,
    destructive: true,
    idempotent: true,
    retrySafe: false,
    longRunning: false,
  },
  resultContract: {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      { id: "operation_succeeded", kind: "tool_status", status: "succeeded" },
      {
        id: "delete_status_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.status",
      },
    ],
  },
  errorContract: {
    codes: deleteErrorContract(),
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateDeleteInput(input);
    if ("ok" in parsed) {
      return filesystemValidationFailure(
        "DELETE_INPUT_INVALID",
        parsed.error ?? "Invalid delete input.",
        "Correct the delete input and retry.",
      );
    }
    return await executeDeleteOperation(parsed, context);
  },
};

export async function executeDeleteOperation(
  input: DeleteInput,
  context?: ToolExecutionContext,
  dependencies: DeleteOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolResult> {
  const start = Date.now();
  const resolved = await resolveContainedMutationPath(
    input.path,
    context,
    "delete",
  );
  if (!resolved.ok) {
    return deleteFailure(
      failedDeleteResult(input, input.path, resolved.issue),
      resolved.issue,
      start,
    );
  }
  const targetPath = resolved.path;
  const preconditions = filesystemPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const expected = preconditions.get(targetPath)
    ?? await observeFilesystemTarget(targetPath);

  if (expected.kind === "missing") {
    const current = await observeFilesystemTarget(targetPath);
    if (!sameFilesystemTargetState(expected, current)) {
      return deleteConflict(input, targetPath, expected, current, start);
    }
    return deleteSuccess({
      requestedPath: input.path,
      targetPath,
      status: "already_absent",
      deleted: false,
    }, start);
  }
  if (expected.kind === "other") {
    const issue = deleteIssue(
      "DELETE_UNSUPPORTED_TARGET_KIND",
      `Delete supports files, directories, and symbolic links only: ${targetPath}`,
      "semantic",
      targetPath,
    );
    return deleteFailure(
      failedDeleteResult(input, targetPath, issue),
      issue,
      start,
    );
  }
  if (expected.kind === "directory" && input.recursive !== true) {
    const issue = deleteIssue(
      "DELETE_DIRECTORY_REQUIRES_RECURSIVE",
      "Target is a directory. Set recursive=true only when deleting this directory is intended.",
      "validation",
      targetPath,
      true,
    );
    return deleteFailure(
      failedDeleteResult(input, targetPath, issue, "directory"),
      issue,
      start,
    );
  }

  const current = await observeFilesystemTarget(targetPath);
  if (!sameFilesystemTargetState(expected, current)) {
    return deleteConflict(input, targetPath, expected, current, start);
  }

  if (expected.kind !== "directory") {
    try {
      await dependencies.unlink(targetPath);
    } catch (error) {
      const issue = classifyFilesystemOperationError(
        error,
        targetPath,
        "DELETE",
      );
      return deleteFailure(
        failedDeleteResult(input, targetPath, issue, expected.kind),
        issue,
        start,
      );
    }
    return await verifySimpleDelete(
      input,
      targetPath,
      expected.kind,
      start,
    );
  }

  return await deleteDirectory(
    input,
    targetPath,
    dependencies,
    start,
  );
}

async function verifySimpleDelete(
  input: DeleteInput,
  targetPath: string,
  kind: "file" | "symlink",
  start: number,
): Promise<ToolResult> {
  const after = await observeFilesystemTarget(targetPath);
  if (after.kind !== "missing") {
    const issue = deleteIssue(
      "DELETE_VERIFICATION_FAILED",
      `Delete returned without removing the requested path: ${targetPath}`,
      "conflict",
      targetPath,
    );
    issue.actual = summarizeFilesystemTargetState(after);
    return deleteFailure({
      requestedPath: input.path,
      targetPath,
      kind,
      status: "failed",
      deleted: false,
      errorCode: issue.code,
      errorMessage: issue.message,
    }, issue, start);
  }
  return deleteSuccess({
    requestedPath: input.path,
    targetPath,
    kind,
    status: "deleted",
    deleted: true,
  }, start);
}

async function deleteDirectory(
  input: DeleteInput,
  targetPath: string,
  dependencies: DeleteOperationDependencies,
  start: number,
): Promise<ToolResult> {
  let cleanupPath: string | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < DELETE_STAGING_ATTEMPTS; attempt += 1) {
    cleanupPath = join(
      dirname(targetPath),
      `.ayati-delete-${randomUUID()}-${basename(targetPath)}`,
    );
    try {
      await dependencies.rename(targetPath, cleanupPath);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
    }
  }
  if (lastError || !cleanupPath) {
    const issue = classifyFilesystemOperationError(
      lastError,
      targetPath,
      "DELETE",
    );
    return deleteFailure(
      failedDeleteResult(input, targetPath, issue, "directory"),
      issue,
      start,
    );
  }

  const afterRename = await observeFilesystemTarget(targetPath);
  if (afterRename.kind !== "missing") {
    const issue = deleteIssue(
      "DELETE_VERIFICATION_FAILED",
      `Directory staging did not remove the requested path: ${targetPath}`,
      "conflict",
      targetPath,
    );
    return deleteFailure({
      requestedPath: input.path,
      targetPath,
      kind: "directory",
      status: "cleanup_pending",
      deleted: false,
      cleanupPath,
      errorCode: issue.code,
      errorMessage: issue.message,
    }, issue, start);
  }

  try {
    await dependencies.remove(cleanupPath, {
      recursive: true,
      force: false,
    });
  } catch (error) {
    if ((await observeFilesystemTarget(cleanupPath)).kind === "missing") {
      return deleteSuccess({
        requestedPath: input.path,
        targetPath,
        kind: "directory",
        status: "deleted",
        deleted: true,
      }, start);
    }
    const base = classifyFilesystemOperationError(
      error,
      cleanupPath,
      "DELETE",
    );
    const issue = {
      ...base,
      code: "DELETE_CLEANUP_PENDING",
      message: `The requested directory was removed, but internal cleanup remains at ${cleanupPath}. ${base.message}`,
    };
    return deleteFailure({
      requestedPath: input.path,
      targetPath,
      kind: "directory",
      status: "cleanup_pending",
      deleted: true,
      cleanupPath,
      errorCode: issue.code,
      errorMessage: issue.message,
    }, issue, start);
  }

  return deleteSuccess({
    requestedPath: input.path,
    targetPath,
    kind: "directory",
    status: "deleted",
    deleted: true,
  }, start);
}

function deleteSuccess(result: DeleteResult, start: number): ToolResult {
  const durationMs = Date.now() - start;
  const message = result.status === "already_absent"
    ? `Path is already absent: ${result.targetPath}`
    : `Deleted ${result.kind}: ${result.targetPath}`;
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: { durationMs, status: result.status, targetPath: result.targetPath },
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: result.status === "already_absent"
        ? "PATH_ALREADY_ABSENT"
        : "PATH_DELETED",
      message,
      structuredContent: result,
      artifacts: result.status === "deleted"
        ? [{
            kind: result.kind === "directory" ? "directory" : "file",
            path: result.targetPath,
            metadata: { deleted: true, kind: result.kind },
          }]
        : [],
      diagnostics: {
        durationMs,
        status: result.status,
        targetPath: result.targetPath,
      },
    },
  };
}

function deleteFailure(
  result: DeleteResult,
  issue: FilesystemOperationIssue,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const partial = result.status === "cleanup_pending";
  const error: ToolStructuredError = {
    category: issue.category,
    code: issue.code,
    message: issue.message,
    retryable: issue.retryable,
    recoverable: issue.recoverable,
    target: issue.target,
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    suggestedNextActions: result.cleanupPath
      ? [`Inspect and remove the internal cleanup path after confirming the requested path is absent: ${result.cleanupPath}`]
      : ["Inspect the current target before constructing another delete operation."],
  };
  return {
    ok: false,
    error: issue.message,
    meta: {
      durationMs,
      status: result.status,
      targetPath: result.targetPath,
      ...(result.cleanupPath ? { cleanupPath: result.cleanupPath } : {}),
      ...(issue.errnoCode ? { errnoCode: issue.errnoCode } : {}),
    },
    v2: {
      transportOk: true,
      operationStatus: partial ? "partial" : "failed",
      code: issue.code,
      message: issue.message,
      structuredContent: result,
      artifacts: result.cleanupPath
        ? [{
            kind: "directory",
            path: result.cleanupPath,
            metadata: { internalCleanupPending: true },
          }]
        : [],
      error,
      diagnostics: {
        durationMs,
        status: result.status,
        ...(result.cleanupPath ? { cleanupPath: result.cleanupPath } : {}),
      },
    },
  };
}

function deleteConflict(
  input: DeleteInput,
  targetPath: string,
  expected: FilesystemTargetState,
  actual: FilesystemTargetState,
  start: number,
): ToolResult {
  const issue = deleteIssue(
    "DELETE_CONFLICT",
    `Delete target changed before execution: ${targetPath}`,
    "conflict",
    targetPath,
    true,
  );
  issue.expected = summarizeFilesystemTargetState(expected);
  issue.actual = summarizeFilesystemTargetState(actual);
  return deleteFailure(
    failedDeleteResult(input, targetPath, issue, filesystemKind(expected)),
    issue,
    start,
  );
}

function failedDeleteResult(
  input: DeleteInput,
  targetPath: string,
  issue: FilesystemOperationIssue,
  kind?: DeleteResult["kind"],
): DeleteResult {
  return {
    requestedPath: input.path,
    targetPath,
    ...(kind ? { kind } : {}),
    status: "failed",
    deleted: false,
    errorCode: issue.code,
    errorMessage: issue.message,
  };
}

function filesystemKind(
  state: FilesystemTargetState,
): DeleteResult["kind"] | undefined {
  return state.kind === "file"
    || state.kind === "directory"
    || state.kind === "symlink"
    ? state.kind
    : undefined;
}

function deleteIssue(
  code: string,
  message: string,
  category: FilesystemOperationIssue["category"],
  target: string,
  retryable = false,
): FilesystemOperationIssue {
  return {
    code,
    message,
    category,
    retryable,
    recoverable: true,
    target,
  };
}

function deleteErrorContract(): NonNullable<ToolDefinition["errorContract"]>["codes"] {
  const definitions: Record<string, [ToolStructuredError["category"], boolean]> = {
    DELETE_INPUT_INVALID: ["validation", true],
    PATH_OUTSIDE_SELECTED_MUTATION_ROOT: ["permission", false],
    DELETE_DIRECTORY_REQUIRES_RECURSIVE: ["validation", true],
    DELETE_UNSUPPORTED_TARGET_KIND: ["semantic", false],
    DELETE_CONFLICT: ["conflict", true],
    DELETE_VERIFICATION_FAILED: ["conflict", false],
    DELETE_CLEANUP_PENDING: ["conflict", false],
    DELETE_PERMISSION_DENIED: ["permission", false],
    DELETE_READ_ONLY_FILESYSTEM: ["permission", false],
    DELETE_PATH_NOT_FOUND: ["missing_path", true],
    DELETE_INVALID_PATH: ["semantic", false],
    DELETE_TEMPORARY_FAILURE: ["transient", true],
    DELETE_FAILED: ["unknown", false],
  };
  return Object.fromEntries(Object.entries(definitions).map(([code, value]) => [
    code,
    recoverableFilesystemErrorContract(value[0], value[1]),
  ]));
}
