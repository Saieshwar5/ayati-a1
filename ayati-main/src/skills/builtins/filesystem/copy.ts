import type {
  ToolDefinition,
  ToolResult,
} from "../../types.js";
import { executeCopyOperation } from "./copy-operation.js";
import {
  filesystemValidationFailure,
  recoverableFilesystemErrorContract,
} from "./path-operation-helpers.js";
import { validateCopyInput } from "./validators.js";

export const copyTool: ToolDefinition = {
  name: "copy",
  description: "Copy one file, directory, or symbolic link into a missing canonical absolute destination. The copy is staged beside the destination, content-verified, and then renamed into place.",
  inputSchema: {
    type: "object",
    required: ["source", "destination"],
    properties: {
      source: {
        type: "string",
        description: "Canonical absolute source path. The source is read-only.",
      },
      destination: {
        type: "string",
        description: "Canonical absolute destination inside the selected mutation root. It must not already exist.",
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
      "status",
      "createdParentPaths",
      "contentSha256",
      "entryCount",
      "totalBytes",
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
      status: {
        type: "string",
        enum: ["copied", "copied_unverified", "failed"],
      },
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
    destructive: false,
    idempotent: false,
    retrySafe: false,
    longRunning: false,
  },
  resultContract: {
    operationStatusPath: "$.operationStatus",
    successWhen: [
      { id: "operation_succeeded", kind: "tool_status", status: "succeeded" },
      {
        id: "copy_status_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.status",
      },
    ],
    artifacts: [{
      kind: "file",
      path: "$.result.structuredContent.destination",
    }],
  },
  errorContract: {
    codes: {
      COPY_INPUT_INVALID: recoverableFilesystemErrorContract("validation", true),
      PATH_OUTSIDE_SELECTED_MUTATION_ROOT: recoverableFilesystemErrorContract("permission", false),
      COPY_SOURCE_NOT_FOUND: recoverableFilesystemErrorContract("missing_path", true),
      COPY_PATH_NOT_FOUND: recoverableFilesystemErrorContract("missing_path", true),
      COPY_DESTINATION_EXISTS: recoverableFilesystemErrorContract("conflict", true),
      COPY_INVALID_RELATIONSHIP: recoverableFilesystemErrorContract("semantic", false),
      COPY_CONFLICT: recoverableFilesystemErrorContract("conflict", true),
      COPY_SOURCE_CHANGED: recoverableFilesystemErrorContract("conflict", true),
      COPY_VERIFICATION_FAILED: recoverableFilesystemErrorContract("conflict", true),
      COPY_UNSUPPORTED_SOURCE_KIND: recoverableFilesystemErrorContract("semantic", false),
      COPY_ENTRY_LIMIT_EXCEEDED: recoverableFilesystemErrorContract("semantic", false),
      COPY_PARENT_MISSING: recoverableFilesystemErrorContract("missing_path", true),
      COPY_PERMISSION_DENIED: recoverableFilesystemErrorContract("permission", false),
      COPY_READ_ONLY_FILESYSTEM: recoverableFilesystemErrorContract("permission", false),
      COPY_STORAGE_FULL: recoverableFilesystemErrorContract("transient", true),
      COPY_INVALID_PATH: recoverableFilesystemErrorContract("semantic", false),
      COPY_TEMPORARY_FAILURE: recoverableFilesystemErrorContract("transient", true),
      COPY_FAILED: recoverableFilesystemErrorContract("unknown", false),
    },
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateCopyInput(input);
    if ("ok" in parsed) {
      return filesystemValidationFailure(
        "COPY_INPUT_INVALID",
        parsed.error ?? "Invalid copy input.",
        "Correct the copy input and retry.",
      );
    }
    return await executeCopyOperation(parsed, context);
  },
};
