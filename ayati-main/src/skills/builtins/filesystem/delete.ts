import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateDeleteInput } from "./validators.js";
import { enforceFilesystemGuard } from "../../guardrails/index.js";

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
      confirmationToken: {
        type: "string",
        description: "Required confirmation token in format CONFIRM:<operation_id> when requested by guardrails.",
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

      const guard = await enforceFilesystemGuard({
        action: "delete",
        path: targetPath,
        recursive: parsed.recursive,
        confirmationToken: parsed.confirmationToken,
      });
      if (!guard.ok) return guard.result;

      await rm(guard.resolvedPath, { recursive: parsed.recursive ?? false, force: false });

      const kind = info.isDirectory() ? "directory" : "file";
      return {
        ok: true,
        output: `Deleted ${kind}: ${guard.resolvedPath}`,
        meta: { durationMs: Date.now() - start, targetPath: guard.resolvedPath, kind },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
