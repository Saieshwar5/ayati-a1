import type { ToolResult } from "../../types.js";
import type { WorkspaceMutationPathRejected } from "../../workspace-paths.js";
import { errorResult } from "../contract-helpers.js";

export function externalWorkspacePathError(rejection: WorkspaceMutationPathRejected): ToolResult {
  return errorResult({
    code: rejection.code,
    message: rejection.message,
    category: "validation",
    target: rejection.resolvedPath,
    retryable: true,
    recoverable: true,
    suggestedNextActions: [
      "Use a workspace-relative path for generated files.",
      "Set allowExternalPath=true only when the user explicitly requested this external path.",
    ],
    structuredContent: {
      requestedPath: rejection.requestedPath,
      resolvedPath: rejection.resolvedPath,
      workspaceRoot: rejection.workspaceRoot,
      operation: rejection.operation,
      allowExternalPathRequired: true,
    },
    meta: {
      requestedPath: rejection.requestedPath,
      resolvedPath: rejection.resolvedPath,
      workspaceRoot: rejection.workspaceRoot,
      operation: rejection.operation,
    },
  });
}
