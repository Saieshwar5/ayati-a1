import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
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
  async execute(input): Promise<ToolResult> {
    const parsed = validateCreateDirectoryInput(input);
    if ("ok" in parsed) return parsed;

    const dirPath = resolve(parsed.path);
    const start = Date.now();

    try {
      await mkdir(dirPath, { recursive: parsed.recursive });

      return {
        ok: true,
        output: `Created directory: ${dirPath}`,
        meta: { durationMs: Date.now() - start, dirPath },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
