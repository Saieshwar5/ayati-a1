import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateDeleteInput } from "./validators.js";

export const deleteTool: ToolDefinition = {
  name: "delete",
  description: "Delete a file or directory. Requires recursive=true to delete directories.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative path to delete." },
      recursive: {
        type: "boolean",
        description: "Delete directories and their contents recursively (default: false).",
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "delete", "remove"],
    aliases: ["remove_file", "rm_file", "delete_path"],
    examples: ["delete this file", "remove directory recursively"],
    domain: "filesystem",
    priority: 1,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateDeleteInput(input);
    if ("ok" in parsed) return parsed;

    const targetPath = resolve(parsed.path);
    const start = Date.now();

    try {
      const info = await stat(targetPath);

      if (info.isDirectory() && !parsed.recursive) {
        return {
          ok: false,
          error: "Target is a directory. Set recursive=true to delete directories.",
          meta: { durationMs: Date.now() - start, targetPath },
        };
      }

      await rm(targetPath, { recursive: parsed.recursive ?? false, force: false });

      const kind = info.isDirectory() ? "directory" : "file";
      return {
        ok: true,
        output: `Deleted ${kind}: ${targetPath}`,
        meta: { durationMs: Date.now() - start, targetPath, kind },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
