import type {
  ToolDefinition,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import { executeMoveOperation } from "./move-operation.js";
import {
  filesystemValidationFailure,
  recoverableFilesystemErrorContract,
} from "./path-operation-helpers.js";
import { validateMoveInput } from "./validators.js";

export const moveTool: ToolDefinition = {
  name: "move",
  description: "Move or rename one canonical filesystem path. Same-filesystem moves use atomic rename; cross-filesystem moves stage and verify a copy before removing the source.",
  inputSchema: {
    type: "object",
    required: ["source", "destination"],
    properties: {
      source: {
        type: "string",
        description: "Source path relative to context.run.workspaceRoot, or a canonical absolute path inside the selected destination root.",
      },
      destination: {
        type: "string",
        description: "Destination path relative to context.run.workspaceRoot, or a canonical absolute path inside the same selected root.",
      },
      overwrite: {
        type: "boolean",
        description: "Replace an existing regular-file destination. Directory and symbolic-link overwrite is not supported. Defaults to false.",
      },
      createParents: {
        type: "boolean",
        description: "Create missing destination parents. Defaults to true.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: [
      "requestedSource",
      "requestedDestination",
      "source",
      "destination",
      "kind",
      "strategy",
      "status",
      "overwrite",
      "moved",
      "createdParentPaths",
    ],
    properties: {
      requestedSource: { type: "string" },
      requestedDestination: { type: "string" },
      source: { type: "string" },
      destination: { type: "string" },
      kind: {
        type: "string",
        enum: ["file", "directory", "symlink"],
      },
      strategy: {
        type: "string",
        enum: ["rename", "copy_delete"],
      },
      status: {
        type: "string",
        enum: [
          "moved",
          "moved_unverified",
          "copied_but_source_retained",
          "failed",
        ],
      },
      overwrite: { type: "boolean" },
      moved: { type: "boolean" },
      createdParentPaths: {
        type: "array",
        items: { type: "string" },
      },
      contentSha256: { type: "string" },
      entryCount: { type: "integer" },
      totalBytes: { type: "integer" },
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
    idempotent: false,
    retrySafe: false,
    longRunning: false,
  },
  resultContract: {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      { id: "operation_succeeded", kind: "tool_status", status: "succeeded" },
      {
        id: "move_status_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.status",
      },
    ],
    artifacts: [{
      kind: "unknown",
      path: "$.result.structuredContent.destination",
    }],
  },
  errorContract: {
    codes: moveErrorContract(),
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateMoveInput(input);
    if ("ok" in parsed) {
      return filesystemValidationFailure(
        "MOVE_INPUT_INVALID",
        parsed.error ?? "Invalid move input.",
        "Correct the move input and retry.",
      );
    }
    return await executeMoveOperation(parsed, context);
  },
};

function moveErrorContract(): NonNullable<ToolDefinition["errorContract"]>["codes"] {
  const definitions: Record<string, [ToolStructuredError["category"], boolean]> = {
    MOVE_INPUT_INVALID: ["validation", true],
    PATH_OUTSIDE_SELECTED_MUTATION_ROOT: ["permission", false],
    MOVE_SOURCE_NOT_FOUND: ["missing_path", true],
    MOVE_PATH_NOT_FOUND: ["missing_path", true],
    MOVE_DESTINATION_EXISTS: ["conflict", true],
    MOVE_OVERWRITE_UNSUPPORTED: ["semantic", false],
    MOVE_INVALID_RELATIONSHIP: ["semantic", false],
    MOVE_UNSUPPORTED_SOURCE_KIND: ["semantic", false],
    MOVE_CONFLICT: ["conflict", true],
    MOVE_SOURCE_CHANGED: ["conflict", true],
    MOVE_COPY_VERIFICATION_FAILED: ["conflict", true],
    MOVE_SOURCE_REMOVE_FAILED: ["conflict", false],
    MOVE_VERIFICATION_FAILED: ["conflict", false],
    MOVE_ENTRY_LIMIT_EXCEEDED: ["semantic", false],
    MOVE_PARENT_MISSING: ["missing_path", true],
    MOVE_PERMISSION_DENIED: ["permission", false],
    MOVE_READ_ONLY_FILESYSTEM: ["permission", false],
    MOVE_STORAGE_FULL: ["transient", true],
    MOVE_INVALID_PATH: ["semantic", false],
    MOVE_TEMPORARY_FAILURE: ["transient", true],
    MOVE_FAILED: ["unknown", false],
  };
  return Object.fromEntries(Object.entries(definitions).map(([code, value]) => [
    code,
    recoverableFilesystemErrorContract(value[0], value[1]),
  ]));
}
