import { chmod } from "node:fs/promises";
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
import type {
  SetPermissionsFileResult,
  SetPermissionsInput,
  SetPermissionsResult,
} from "./types.js";
import {
  MAX_PERMISSION_FILES,
  validateSetPermissionsInput,
} from "./validators.js";

interface PreparedPermissionTarget {
  requestedPath: string;
  path: string;
  requestedMode: string;
  numericMode: number;
  expected: Extract<FilesystemTargetState, { kind: "file" }>;
  plannedStatus: "changed" | "unchanged";
}

export interface SetPermissionsOperationDependencies {
  chmod: typeof chmod;
}

const DEFAULT_DEPENDENCIES: SetPermissionsOperationDependencies = {
  chmod,
};

export const setPermissionsTool: ToolDefinition = {
  name: "set_permissions",
  description: "Make one or more regular files use exact ordinary Unix permission bits. Content is preserved, symbolic links and hard-linked files are rejected, and already-current modes succeed unchanged.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_PERMISSION_FILES,
        items: {
          type: "object",
          required: ["path", "mode"],
          properties: {
            path: {
              type: "string",
              description: "Canonical absolute regular-file path inside the selected destination root.",
            },
            mode: {
              type: "string",
              description: "Three-digit octal permissions such as 644 or 755. Owner-read permission must remain enabled.",
              pattern: "^(?:0?[0-7]{3})$",
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
      "filesChanged",
      "filesUnchanged",
      "filesFailed",
      "files",
    ],
    properties: {
      filesRequested: { type: "integer" },
      filesChanged: { type: "integer" },
      filesUnchanged: { type: "integer" },
      filesFailed: { type: "integer" },
      files: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "requestedMode", "mode", "status", "sha256"],
          properties: {
            path: { type: "string" },
            requestedMode: { type: "string" },
            mode: { type: "string" },
            status: {
              type: "string",
              enum: ["changed", "unchanged", "failed"],
            },
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
        id: "permissions_result_matches_request",
        kind: "json_path_count_equals",
        path: "$.result.structuredContent.files",
        equalsPath: "$.input.files",
      },
      {
        id: "permissions_requested_matches_request",
        kind: "json_path_number_equals_count",
        path: "$.result.structuredContent.filesRequested",
        equalsPath: "$.input.files",
      },
    ],
  },
  errorContract: {
    codes: permissionErrorContract(),
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateSetPermissionsInput(input);
    if ("ok" in parsed) {
      return filesystemValidationFailure(
        "PERMISSIONS_INPUT_INVALID",
        parsed.error ?? "Invalid set_permissions input.",
        "Correct the set_permissions input and retry.",
      );
    }
    return await executeSetPermissionsOperation(parsed, context);
  },
};

export async function executeSetPermissionsOperation(
  input: SetPermissionsInput,
  context?: ToolExecutionContext,
  dependencies: SetPermissionsOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolResult> {
  const start = Date.now();
  const preconditions = filesystemPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const prepared: PreparedPermissionTarget[] = [];
  const seen = new Set<string>();

  for (const requested of input.files) {
    const resolved = await resolveContainedMutationPath(
      requested.path,
      context,
      "set_permissions",
    );
    if (!resolved.ok) {
      return permissionFailure(
        permissionFailureResults(input, prepared, resolved.issue),
        resolved.issue,
        start,
      );
    }
    const path = resolved.path;
    if (seen.has(path)) {
      const issue = permissionIssue(
        "DUPLICATE_TARGET_PATH",
        `Multiple set_permissions entries resolve to the same path: ${path}`,
        "conflict",
        path,
        true,
      );
      return permissionFailure(
        permissionFailureResults(input, prepared, issue),
        issue,
        start,
      );
    }
    seen.add(path);
    const expected = preconditions.get(path)
      ?? await observeFilesystemTarget(path);
    if (expected.kind !== "file") {
      const issue = permissionIssue(
        "PERMISSIONS_TARGET_NOT_REGULAR_FILE",
        `set_permissions requires an existing regular file; observed ${expected.kind}: ${path}`,
        expected.kind === "missing" ? "missing_path" : "semantic",
        path,
        expected.kind === "missing",
      );
      issue.actual = summarizeFilesystemTargetState(expected);
      return permissionFailure(
        permissionFailureResults(input, prepared, issue),
        issue,
        start,
      );
    }
    if (expected.linkCount > 1) {
      const issue = permissionIssue(
        "PERMISSIONS_HARDLINK_UNSUPPORTED",
        `set_permissions will not change a file with ${expected.linkCount} hard links: ${path}`,
        "semantic",
        path,
      );
      return permissionFailure(
        permissionFailureResults(input, prepared, issue),
        issue,
        start,
      );
    }
    const numericMode = Number.parseInt(requested.mode, 8);
    prepared.push({
      requestedPath: requested.path,
      path,
      requestedMode: requested.mode,
      numericMode,
      expected,
      plannedStatus: expected.mode === numericMode
        ? "unchanged"
        : "changed",
    });
  }

  for (const target of prepared) {
    const current = await observeFilesystemTarget(target.path);
    if (!sameFilesystemTargetState(target.expected, current)) {
      const issue = permissionIssue(
        "PERMISSIONS_CONFLICT",
        `Permission target changed before execution: ${target.path}`,
        "conflict",
        target.path,
        true,
      );
      issue.expected = summarizeFilesystemTargetState(target.expected);
      issue.actual = summarizeFilesystemTargetState(current);
      return permissionFailure(
        permissionFailureResults(input, prepared, issue),
        issue,
        start,
      );
    }
  }

  const completed = new Map<string, SetPermissionsFileResult>();
  for (const target of prepared) {
    if (target.plannedStatus === "unchanged") {
      completed.set(target.path, targetResult(target, "unchanged"));
      continue;
    }
    try {
      await dependencies.chmod(target.path, target.numericMode);
      const after = await observeFilesystemTarget(target.path);
      if (
        after.kind !== "file"
        || after.sha256 !== target.expected.sha256
        || after.mode !== target.numericMode
        || after.device !== target.expected.device
        || after.inode !== target.expected.inode
      ) {
        const issue = permissionIssue(
          "PERMISSIONS_VERIFICATION_FAILED",
          `File mode change could not be verified without a content or identity change: ${target.path}`,
          "conflict",
          target.path,
        );
        issue.expected = {
          sha256: target.expected.sha256,
          mode: target.requestedMode,
          device: target.expected.device,
          inode: target.expected.inode,
        };
        issue.actual = summarizeFilesystemTargetState(after);
        return permissionFailure(
          permissionFailureResults(input, prepared, issue, completed),
          issue,
          start,
        );
      }
      completed.set(target.path, targetResult(target, "changed"));
    } catch (error) {
      const issue = classifyFilesystemOperationError(
        error,
        target.path,
        "PERMISSIONS",
      );
      return permissionFailure(
        permissionFailureResults(input, prepared, issue, completed),
        issue,
        start,
      );
    }
  }

  return permissionSuccess(
    summarizePermissionResults(prepared.map((target) => (
      completed.get(target.path) ?? targetResult(target, "failed")
    ))),
    start,
  );
}

function permissionSuccess(
  result: SetPermissionsResult,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const message = result.filesChanged === 0
    ? `${result.filesUnchanged} file mode${result.filesUnchanged === 1 ? " is" : "s are"} already current.`
    : `Changed permissions for ${result.filesChanged} file${result.filesChanged === 1 ? "" : "s"}.`;
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: permissionDiagnostics(result, durationMs),
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: result.filesChanged === 0
        ? "PERMISSIONS_ALREADY_CURRENT"
        : "PERMISSIONS_APPLIED",
      message,
      structuredContent: result,
      artifacts: [],
      diagnostics: permissionDiagnostics(result, durationMs),
    },
  };
}

function permissionFailure(
  result: SetPermissionsResult,
  issue: FilesystemOperationIssue,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const partial = result.filesChanged > 0;
  const error: ToolStructuredError = {
    category: issue.category,
    code: issue.code,
    message: issue.message,
    retryable: issue.retryable,
    recoverable: issue.recoverable,
    target: issue.target,
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    suggestedNextActions: partial
      ? ["Retry the same desired permission modes; completed files will be unchanged."]
      : ["Inspect the current target metadata and retry with supported regular files."],
  };
  return {
    ok: false,
    error: issue.message,
    meta: {
      ...permissionDiagnostics(result, durationMs),
      ...(issue.errnoCode ? { errnoCode: issue.errnoCode } : {}),
    },
    v2: {
      transportOk: true,
      operationStatus: partial ? "partial" : "failed",
      code: partial ? "PERMISSIONS_PARTIAL" : issue.code,
      message: issue.message,
      structuredContent: result,
      artifacts: [],
      error,
      diagnostics: permissionDiagnostics(result, durationMs),
    },
  };
}

function permissionFailureResults(
  input: SetPermissionsInput,
  prepared: PreparedPermissionTarget[],
  issue: FilesystemOperationIssue,
  completed: Map<string, SetPermissionsFileResult> = new Map(),
): SetPermissionsResult {
  const byRequestedPath = new Map(
    prepared.map((target) => [target.requestedPath, target]),
  );
  return summarizePermissionResults(input.files.map((requested) => {
    const target = byRequestedPath.get(requested.path);
    if (!target) {
      return {
        path: requested.path,
        requestedMode: requested.mode,
        mode: "",
        status: "failed",
        sha256: "",
        errorCode: issue.code,
        errorMessage: issue.message,
      };
    }
    return completed.get(target.path)
      ?? (target.plannedStatus === "unchanged"
        ? targetResult(target, "unchanged")
        : targetResult(target, "failed", issue));
  }));
}

function targetResult(
  target: PreparedPermissionTarget,
  status: SetPermissionsFileResult["status"],
  issue?: FilesystemOperationIssue,
): SetPermissionsFileResult {
  return {
    path: target.path,
    requestedMode: target.requestedMode,
    mode: status === "changed" || status === "unchanged"
      ? target.requestedMode
      : octalMode(target.expected.mode),
    status,
    sha256: target.expected.sha256,
    ...(issue ? {
      errorCode: issue.code,
      errorMessage: issue.message,
    } : {}),
  };
}

function summarizePermissionResults(
  files: SetPermissionsFileResult[],
): SetPermissionsResult {
  return {
    filesRequested: files.length,
    filesChanged: files.filter((file) => file.status === "changed").length,
    filesUnchanged: files.filter((file) => file.status === "unchanged").length,
    filesFailed: files.filter((file) => file.status === "failed").length,
    files,
  };
}

function octalMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function permissionIssue(
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

function permissionDiagnostics(
  result: SetPermissionsResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    durationMs,
    filesRequested: result.filesRequested,
    filesChanged: result.filesChanged,
    filesUnchanged: result.filesUnchanged,
    filesFailed: result.filesFailed,
  };
}

function permissionErrorContract(): NonNullable<ToolDefinition["errorContract"]>["codes"] {
  const definitions: Record<string, [ToolStructuredError["category"], boolean]> = {
    PERMISSIONS_INPUT_INVALID: ["validation", true],
    DUPLICATE_TARGET_PATH: ["conflict", true],
    PATH_OUTSIDE_SELECTED_MUTATION_ROOT: ["permission", false],
    PERMISSIONS_TARGET_NOT_REGULAR_FILE: ["semantic", false],
    PERMISSIONS_HARDLINK_UNSUPPORTED: ["semantic", false],
    PERMISSIONS_CONFLICT: ["conflict", true],
    PERMISSIONS_VERIFICATION_FAILED: ["conflict", false],
    PERMISSIONS_PERMISSION_DENIED: ["permission", false],
    PERMISSIONS_READ_ONLY_FILESYSTEM: ["permission", false],
    PERMISSIONS_PATH_NOT_FOUND: ["missing_path", true],
    PERMISSIONS_INVALID_PATH: ["semantic", false],
    PERMISSIONS_TEMPORARY_FAILURE: ["transient", true],
    PERMISSIONS_PARTIAL: ["conflict", true],
    PERMISSIONS_FAILED: ["unknown", false],
  };
  return Object.fromEntries(Object.entries(definitions).map(([code, value]) => [
    code,
    recoverableFilesystemErrorContract(value[0], value[1]),
  ]));
}
