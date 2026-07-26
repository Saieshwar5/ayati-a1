import type { ToolResult } from "../skills/types.js";

export type ResourceScopeFailureCode =
  | "WORKSTREAM_RESOURCE_SCOPE_VIOLATION"
  | "WORKSTREAM_RESOURCE_MUTATION_DENIED"
  | "ABSOLUTE_PATH_REQUIRED"
  | "PATH_OUTSIDE_MUTATION_WORKSPACE"
  | "PATH_OUTSIDE_RESOURCE_SCOPE"
  | "PATH_OUTSIDE_WORKSPACE_ROOT"
  | "R_MUTATION_REQUIRES_WORKSTREAM_BINDING";

export function resourceScopeFailure(
  code: ResourceScopeFailureCode,
  message: string,
  target?: string,
): ToolResult {
  const outsideMutationWorkspace = code === "PATH_OUTSIDE_MUTATION_WORKSPACE";
  return {
    ok: false,
    error: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      error: {
        category: code === "ABSOLUTE_PATH_REQUIRED" ? "validation" : "permission",
        code,
        message,
        retryable: !outsideMutationWorkspace,
        recoverable: true,
        ...(target ? { target } : {}),
        suggestedNextActions: [
          code === "R_MUTATION_REQUIRES_WORKSTREAM_BINDING"
            ? "Create or activate the correct workstream, then make a fresh mutation decision."
            : outsideMutationWorkspace
              ? "Choose an exact target inside the configured Ayati workspace."
              : "Use an absolute path inside one resource bound to the active workstream.",
        ],
      },
    },
  };
}
