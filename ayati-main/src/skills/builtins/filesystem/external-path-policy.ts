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
      "Use an absolute path inside one filesystem resource bound to the active workstream.",
      "If the user requested another location, inspect and bind that exact resource before mutation.",
    ],
    structuredContent: {
      requestedPath: rejection.requestedPath,
      resolvedPath: rejection.resolvedPath,
      workspaceRoot: rejection.workspaceRoot,
      operation: rejection.operation,
      requiresAuthorizedWorkingDirectory: true,
    },
    meta: {
      requestedPath: rejection.requestedPath,
      resolvedPath: rejection.resolvedPath,
      workspaceRoot: rejection.workspaceRoot,
      operation: rejection.operation,
    },
  });
}
