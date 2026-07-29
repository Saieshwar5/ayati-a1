import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  filesystemPreconditionMap,
  observeFilesystemTarget,
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  ArtifactRef,
  FilesystemTargetState,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import {
  type CreateDirectoryInput,
  type CreateDirectoryResult,
} from "./types.js";
import { validateCreateDirectoryInput } from "./validators.js";
import {
  classifyFilesystemOperationError,
  resolveContainedMutationPath,
  type FilesystemOperationIssue,
} from "./path-operation-helpers.js";

export interface CreateDirectoryOperationDependencies {
  mkdir: typeof mkdir;
}

const DEFAULT_DEPENDENCIES: CreateDirectoryOperationDependencies = {
  mkdir,
};

export const createDirectoryTool: ToolDefinition = {
  name: "create_directory",
  description: "Ensure one canonical absolute directory exists. Existing directories succeed unchanged, recursive parent creation is explicit in the result, and stale target state is rejected.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to context.run.workspaceRoot, or a canonical absolute path inside the selected destination root.",
      },
      recursive: {
        type: "boolean",
        description: "Create missing parent directories. Defaults to true.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: [
      "requestedPath",
      "dirPath",
      "recursive",
      "status",
      "createdPaths",
    ],
    properties: {
      requestedPath: { type: "string" },
      dirPath: { type: "string" },
      recursive: { type: "boolean" },
      status: {
        type: "string",
        enum: ["created", "already_exists", "partial", "failed"],
      },
      createdPaths: {
        type: "array",
        items: { type: "string" },
      },
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
        id: "directory_status_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.status",
      },
    ],
    artifacts: [{
      kind: "directory",
      path: "$.result.structuredContent.dirPath",
    }],
  },
  errorContract: {
    codes: {
      CREATE_INPUT_INVALID: recoverableError("validation", true),
      PATH_OUTSIDE_SELECTED_MUTATION_ROOT: recoverableError("permission", false),
      CREATE_TARGET_NOT_DIRECTORY: recoverableError("semantic", false),
      CREATE_PARENT_MISSING: recoverableError("missing_path", true),
      CREATE_PATH_NOT_FOUND: recoverableError("missing_path", true),
      CREATE_CONFLICT: recoverableError("conflict", true),
      CREATE_DESTINATION_EXISTS: recoverableError("conflict", true),
      CREATE_PERMISSION_DENIED: recoverableError("permission", false),
      CREATE_READ_ONLY_FILESYSTEM: recoverableError("permission", false),
      CREATE_STORAGE_FULL: recoverableError("transient", true),
      CREATE_INVALID_PATH: recoverableError("semantic", false),
      CREATE_TEMPORARY_FAILURE: recoverableError("transient", true),
      CREATE_PARTIAL: recoverableError("conflict", true),
      CREATE_FAILED: recoverableError("unknown", false),
    },
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateCreateDirectoryInput(input);
    if ("ok" in parsed) {
      return validationFailure(parsed.error ?? "Invalid create_directory input.");
    }
    return await executeCreateDirectoryOperation(parsed, context);
  },
};

export async function executeCreateDirectoryOperation(
  input: CreateDirectoryInput,
  context?: ToolExecutionContext,
  dependencies: CreateDirectoryOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolResult> {
  const start = Date.now();
  const resolved = await resolveContainedMutationPath(
    input.path,
    context,
    "create_directory",
  );
  if (!resolved.ok) {
    return operationFailure(
      failedResult(input, input.path, [], resolved.issue),
      resolved.issue,
      start,
    );
  }
  const dirPath = resolved.path;
  const preconditions = filesystemPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const expected = preconditions.get(dirPath)
    ?? await observeFilesystemTarget(dirPath);

  if (expected.kind === "directory") {
    const current = await observeFilesystemTarget(dirPath);
    if (!sameFilesystemTargetState(expected, current)) {
      return conflictResult(input, dirPath, expected, current, start);
    }
    return successResult({
      requestedPath: input.path,
      dirPath,
      recursive: input.recursive !== false,
      status: "already_exists",
      createdPaths: [],
    }, start);
  }
  if (expected.kind !== "missing") {
    const issue: FilesystemOperationIssue = {
      code: "CREATE_TARGET_NOT_DIRECTORY",
      message: `create_directory target must be missing or a directory; observed ${expected.kind}: ${dirPath}`,
      category: "semantic",
      retryable: false,
      recoverable: true,
      target: dirPath,
      actual: summarizeFilesystemTargetState(expected),
    };
    return operationFailure(
      failedResult(input, dirPath, [], issue),
      issue,
      start,
    );
  }

  const missing = await missingDirectorySuffix(dirPath);
  if (!missing.ok) {
    return operationFailure(
      failedResult(input, dirPath, [], missing.issue),
      missing.issue,
      start,
    );
  }
  if (input.recursive === false && missing.paths.length > 1) {
    const issue: FilesystemOperationIssue = {
      code: "CREATE_PARENT_MISSING",
      message: `Parent directory does not exist: ${dirname(dirPath)}`,
      category: "missing_path",
      retryable: true,
      recoverable: true,
      target: dirname(dirPath),
    };
    return operationFailure(
      failedResult(input, dirPath, [], issue),
      issue,
      start,
    );
  }

  const current = await observeFilesystemTarget(dirPath);
  if (!sameFilesystemTargetState(expected, current)) {
    return conflictResult(input, dirPath, expected, current, start);
  }

  try {
    await dependencies.mkdir(dirPath, { recursive: input.recursive !== false });
  } catch (error) {
    const createdPaths = await createdDirectories(missing.paths);
    const base = classifyFilesystemOperationError(error, dirPath, "CREATE");
    const issue = createdPaths.length > 0
      ? {
          ...base,
          code: "CREATE_PARTIAL",
          message: `${base.message} (${createdPaths.length} parent director${createdPaths.length === 1 ? "y was" : "ies were"} already created)`,
        }
      : base;
    const result: CreateDirectoryResult = {
      requestedPath: input.path,
      dirPath,
      recursive: input.recursive !== false,
      status: createdPaths.length > 0 ? "partial" : "failed",
      createdPaths,
      errorCode: issue.code,
      errorMessage: issue.message,
    };
    return operationFailure(result, issue, start);
  }

  const after = await observeFilesystemTarget(dirPath);
  if (after.kind !== "directory") {
    const issue: FilesystemOperationIssue = {
      code: "CREATE_FAILED",
      message: `create_directory completed without producing a directory: ${dirPath}`,
      category: "unknown",
      retryable: false,
      recoverable: true,
      target: dirPath,
      actual: summarizeFilesystemTargetState(after),
    };
    return operationFailure(
      failedResult(input, dirPath, await createdDirectories(missing.paths), issue),
      issue,
      start,
    );
  }

  return successResult({
    requestedPath: input.path,
    dirPath,
    recursive: input.recursive !== false,
    status: "created",
    createdPaths: await createdDirectories(missing.paths),
  }, start);
}

async function missingDirectorySuffix(
  target: string,
): Promise<
  | { ok: true; paths: string[] }
  | { ok: false; issue: FilesystemOperationIssue }
> {
  const paths: string[] = [];
  let current = target;
  while (true) {
    const state = await observeFilesystemTarget(current);
    if (state.kind === "directory") {
      return { ok: true, paths: paths.reverse() };
    }
    if (state.kind !== "missing") {
      return {
        ok: false,
        issue: {
          code: "CREATE_TARGET_NOT_DIRECTORY",
          message: `A required directory path is ${state.kind}: ${current}`,
          category: "semantic",
          retryable: false,
          recoverable: true,
          target: current,
          actual: summarizeFilesystemTargetState(state),
        },
      };
    }
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return {
        ok: false,
        issue: {
          code: "CREATE_PARENT_MISSING",
          message: `No existing directory ancestor is available for ${target}.`,
          category: "missing_path",
          retryable: false,
          recoverable: true,
          target,
        },
      };
    }
    current = parent;
  }
}

async function createdDirectories(paths: string[]): Promise<string[]> {
  const created: string[] = [];
  for (const path of paths) {
    if ((await observeFilesystemTarget(path)).kind === "directory") {
      created.push(path);
    }
  }
  return created;
}

function successResult(
  result: CreateDirectoryResult,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const changed = result.status === "created";
  const message = changed
    ? `Created directory: ${result.dirPath}`
    : `Directory already exists: ${result.dirPath}`;
  const artifact: ArtifactRef = {
    kind: "directory",
    path: result.dirPath,
    label: result.dirPath,
    metadata: { status: result.status },
  };
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: { durationMs, status: result.status, dirPath: result.dirPath },
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: changed ? "DIRECTORY_CREATED" : "DIRECTORY_ALREADY_EXISTS",
      message,
      structuredContent: result,
      artifacts: [artifact],
      diagnostics: { durationMs, status: result.status },
    },
  };
}

function conflictResult(
  input: CreateDirectoryInput,
  dirPath: string,
  expected: FilesystemTargetState,
  actual: FilesystemTargetState,
  start: number,
): ToolResult {
  const issue: FilesystemOperationIssue = {
    code: "CREATE_CONFLICT",
    message: `Directory target changed while create_directory was preparing: ${dirPath}`,
    category: "conflict",
    retryable: true,
    recoverable: true,
    target: dirPath,
    expected: summarizeFilesystemTargetState(expected),
    actual: summarizeFilesystemTargetState(actual),
  };
  return operationFailure(failedResult(input, dirPath, [], issue), issue, start);
}

function failedResult(
  input: CreateDirectoryInput,
  dirPath: string,
  createdPaths: string[],
  issue: FilesystemOperationIssue,
): CreateDirectoryResult {
  return {
    requestedPath: input.path,
    dirPath,
    recursive: input.recursive !== false,
    status: createdPaths.length > 0 ? "partial" : "failed",
    createdPaths,
    errorCode: issue.code,
    errorMessage: issue.message,
  };
}

function operationFailure(
  result: CreateDirectoryResult,
  issue: FilesystemOperationIssue,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const error: ToolStructuredError = {
    category: issue.category,
    code: issue.code,
    message: issue.message,
    retryable: issue.retryable,
    recoverable: issue.recoverable,
    target: issue.target,
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    suggestedNextActions: issue.code === "CREATE_CONFLICT"
      ? ["Inspect the current path and retry the desired directory state."]
      : ["Correct the reported path condition and retry create_directory."],
  };
  return {
    ok: false,
    error: issue.message,
    meta: {
      durationMs,
      status: result.status,
      createdPathCount: result.createdPaths.length,
      ...(issue.errnoCode ? { errnoCode: issue.errnoCode } : {}),
    },
    v2: {
      transportOk: true,
      operationStatus: result.status === "partial" ? "partial" : "failed",
      code: issue.code,
      message: issue.message,
      structuredContent: result,
      artifacts: result.createdPaths.map((path) => ({
        kind: "directory" as const,
        path,
        label: path,
        metadata: { status: "created_during_partial_operation" },
      })),
      error,
      diagnostics: {
        durationMs,
        status: result.status,
        createdPathCount: result.createdPaths.length,
      },
    },
  };
}

function validationFailure(message: string): ToolResult {
  return {
    ok: false,
    error: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code: "CREATE_INPUT_INVALID",
      message,
      error: {
        category: "validation",
        code: "CREATE_INPUT_INVALID",
        message,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Correct the create_directory input and retry."],
      },
    },
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
    suggestedNextActions: ["Resolve the reported filesystem condition and retry."],
  };
}
