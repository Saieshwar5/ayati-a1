import { mkdir } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { commonAnnotations, errorResultFromUnknown, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { validateCreateDirectoryInput } from "./validators.js";

export const createDirectoryTool: ToolDefinition = {
  name: "create_directory",
  description: "Create a directory. Recursive by default (creates parent directories).",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative directory path." },
      recursive: {
        type: "boolean",
        description: "Create parent directories if needed (default: true).",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "dirPath", "recursive"],
    properties: {
      requestedPath: { type: "string" },
      dirPath: { type: "string" },
      recursive: { type: "boolean" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: false,
    mutatesWorkspace: true,
    idempotent: true,
    retrySafe: true,
  }),
  resultContract: succeededContract({
    assertions: [{
      id: "created_directory_exists",
      kind: "file_exists",
      path: "$.result.structuredContent.dirPath",
    }],
    artifacts: [{ kind: "directory", path: "$.result.structuredContent.dirPath" }],
    progressFacts: [{
      kind: "directory_created",
      path: "$.result.structuredContent.dirPath",
      message: "Directory created by create_directory.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "directory", "mkdir", "create"],
    aliases: ["make_directory", "mkdir"],
    examples: ["create folder", "make directory"],
    domain: "filesystem",
    priority: 3,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateCreateDirectoryInput(input);
    if ("ok" in parsed) return parsed;

    const dirPath = resolveWorkspacePath(parsed.path);
    const start = Date.now();

    try {
      await mkdir(dirPath, { recursive: parsed.recursive });

      const durationMs = Date.now() - start;
      const structuredContent = {
        requestedPath: parsed.path,
        dirPath,
        recursive: parsed.recursive,
      };
      const meta = { durationMs, dirPath };
      return okResult({
        output: `Created directory: ${dirPath}`,
        meta,
        v2: successV2({
          code: "DIRECTORY_CREATED",
          message: `Created directory: ${dirPath}`,
          structuredContent,
          artifacts: [{ kind: "directory", path: dirPath }],
          diagnostics: meta,
        }),
      });
    } catch (err) {
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: dirPath,
        meta: { durationMs: Date.now() - start, dirPath },
      });
    }
  },
};
