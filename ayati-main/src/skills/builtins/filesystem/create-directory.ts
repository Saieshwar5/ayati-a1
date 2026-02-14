import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateCreateDirectoryInput } from "./validators.js";
import { enforceFilesystemGuard } from "../../guardrails/index.js";

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
      confirmationToken: {
        type: "string",
        description: "Required when guardrails request confirmation for this create operation.",
      },
    },
  },
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

    const dirPath = resolve(parsed.path);
    const guard = await enforceFilesystemGuard({
      action: "create_directory",
      path: dirPath,
      confirmationToken: parsed.confirmationToken,
    });
    if (!guard.ok) return guard.result;
    const start = Date.now();

    try {
      await mkdir(guard.resolvedPath, { recursive: parsed.recursive });

      return {
        ok: true,
        output: `Created directory: ${guard.resolvedPath}`,
        meta: { durationMs: Date.now() - start, dirPath: guard.resolvedPath },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
