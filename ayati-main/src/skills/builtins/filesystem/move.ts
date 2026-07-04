import { rename, copyFile, cp, stat, rm, access } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspaceMutationPath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, errorResultFromUnknown, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { externalWorkspacePathError } from "./external-path-policy.js";
import { validateMoveInput } from "./validators.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const moveTool: ToolDefinition = {
  name: "move",
  description: "Move or rename a file or directory. Falls back to copy+delete for cross-device moves.",
  inputSchema: {
    type: "object",
    required: ["source", "destination"],
    properties: {
      source: {
        type: "string",
        description: "Workspace-relative source path by default. Absolute paths outside the workspace require allowExternalPath=true.",
      },
      destination: {
        type: "string",
        description: "Workspace-relative destination path by default. Absolute paths outside the workspace require allowExternalPath=true.",
      },
      overwrite: {
        type: "boolean",
        description: "Overwrite destination if it exists (default: false).",
      },
      allowExternalPath: {
        type: "boolean",
        description: "Allow moving from or to absolute paths outside the configured workspace. Use only when the user explicitly requested those external paths.",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedSource", "requestedDestination", "source", "destination", "moved"],
    properties: {
      requestedSource: { type: "string" },
      requestedDestination: { type: "string" },
      source: { type: "string" },
      destination: { type: "string" },
      kind: { type: "string" },
      overwrite: { type: "boolean" },
      moved: { type: "boolean" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    destructive: false,
    idempotent: false,
    retrySafe: false,
  }),
  resultContract: succeededContract({
    assertions: [
      {
        id: "destination_exists",
        kind: "file_exists",
        path: "$.result.structuredContent.destination",
      },
      {
        id: "source_absent",
        kind: "file_not_exists",
        path: "$.result.structuredContent.source",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.destination" }],
    progressFacts: [{
      kind: "path_moved",
      path: "$.result.structuredContent.destination",
      message: "Path moved by move.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "move", "rename"],
    aliases: ["mv", "rename_path"],
    examples: ["move file", "rename directory"],
    domain: "filesystem",
    priority: 2,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateMoveInput(input);
    if ("ok" in parsed) return parsed;

    const resolvedSource = resolveWorkspaceMutationPath(parsed.source, {
      allowExternalPath: parsed.allowExternalPath,
      operation: "move source",
    });
    if (!resolvedSource.ok) return externalWorkspacePathError(resolvedSource);

    const resolvedDestination = resolveWorkspaceMutationPath(parsed.destination, {
      allowExternalPath: parsed.allowExternalPath,
      operation: "move destination",
    });
    if (!resolvedDestination.ok) return externalWorkspacePathError(resolvedDestination);

    const src = resolvedSource.path;
    const dest = resolvedDestination.path;
    const start = Date.now();

    try {
      if (!parsed.overwrite && (await exists(dest))) {
        return errorResult({
          code: "DESTINATION_EXISTS",
          message: "Destination already exists. Set overwrite=true to replace.",
          category: "conflict",
          target: dest,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry move with overwrite=true or choose a different destination."],
          meta: { durationMs: Date.now() - start, source: src, destination: dest },
        });
      }

      let kind = "unknown";
      try {
        await rename(src, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw err;

        const info = await stat(src);
        kind = info.isDirectory() ? "directory" : "file";
        if (info.isDirectory()) {
          await cp(src, dest, { recursive: true, force: parsed.overwrite ?? false });
        } else {
          await copyFile(src, dest);
        }
        await rm(src, { recursive: true, force: true });
      }

      if (kind === "unknown") {
        const destInfo = await stat(dest);
        kind = destInfo.isDirectory() ? "directory" : "file";
      }

      const durationMs = Date.now() - start;
      const structuredContent = {
        requestedSource: parsed.source,
        requestedDestination: parsed.destination,
        source: src,
        destination: dest,
        kind,
        overwrite: parsed.overwrite === true,
        moved: true,
      };
      const meta = { durationMs, source: src, destination: dest, kind };
      return okResult({
        output: `Moved ${src} -> ${dest}`,
        meta,
        v2: successV2({
          code: "PATH_MOVED",
          message: `Moved ${src} to ${dest}`,
          structuredContent,
          artifacts: [{ kind: kind === "directory" ? "directory" : "file", path: dest }],
          diagnostics: meta,
        }),
      });
    } catch (err) {
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: src,
        meta: { durationMs: Date.now() - start, source: src, destination: dest },
      });
    }
  },
};
