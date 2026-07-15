import { rm, stat } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, errorResultFromUnknown, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validateDeleteInput } from "./validators.js";

export const deleteTool: ToolDefinition = {
  name: "delete",
  description: "Delete a file or directory. Requires recursive=true to delete directories.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Target path. In a task run, use a path relative to the active task root and do not repeat the task directory name. Otherwise, relative paths use the workspace root.",
      },
      recursive: {
        type: "boolean",
        description: "Delete directories and their contents recursively (default: false).",
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow an absolute path outside the configured workspace for non-task work. Task runs ignore this flag and cannot escape the active task root.",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "targetPath", "kind", "deleted"],
    properties: {
      requestedPath: { type: "string" },
      targetPath: { type: "string" },
      kind: { type: "string" },
      deleted: { type: "boolean" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    destructive: true,
    idempotent: false,
    retrySafe: false,
  }),
  resultContract: succeededContract({
    assertions: [{
      id: "deleted_path_absent",
      kind: "file_not_exists",
      path: "$.result.structuredContent.targetPath",
    }],
    progressFacts: [{
      kind: "path_deleted",
      path: "$.result.structuredContent.targetPath",
      message: "Path deleted by delete.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "delete", "remove"],
    aliases: ["remove_file", "rm_file", "delete_path"],
    examples: ["delete this file", "remove directory recursively"],
    domain: "filesystem",
    priority: 1,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateDeleteInput(input);
    if ("ok" in parsed) return parsed;

    const resolved = resolveWorkspaceMutationPath(parsed.path, {
      allowExternalPath: parsed.allowExternalPath,
      operation: "delete",
      root: context?.resourceScope?.rootPath,
    });
    if (!resolved.ok) return externalWorkspacePathError(resolved);

    const targetPath = resolved.path;
    const start = Date.now();

    try {
      const info = await stat(targetPath);

      if (info.isDirectory() && !parsed.recursive) {
        return errorResult({
          code: "DIRECTORY_REQUIRES_RECURSIVE",
          message: "Target is a directory. Set recursive=true to delete directories.",
          category: "validation",
          target: targetPath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry delete with recursive=true if deleting this directory is intended."],
          meta: { durationMs: Date.now() - start, targetPath },
        });
      }

      await rm(targetPath, { recursive: parsed.recursive ?? false, force: false });

      const kind = info.isDirectory() ? "directory" : "file";
      const durationMs = Date.now() - start;
      const structuredContent = {
        requestedPath: parsed.path,
        targetPath,
        kind,
        deleted: true,
      };
      const meta = { durationMs, targetPath, kind };
      return okResult({
        output: `Deleted ${kind}: ${targetPath}`,
        meta,
        v2: successV2({
          code: "PATH_DELETED",
          message: `Deleted ${kind}: ${targetPath}`,
          structuredContent,
          artifacts: [{ kind, path: targetPath, metadata: { deleted: true } }],
          diagnostics: meta,
        }),
      });
    } catch (err) {
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: targetPath,
        meta: { durationMs: Date.now() - start, targetPath },
      });
    }
  },
};
