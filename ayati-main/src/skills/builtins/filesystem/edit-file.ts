import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateEditFileInput } from "./validators.js";
import { enforceFilesystemGuard } from "../../guardrails/index.js";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description: "Find and replace text within a file. Can replace a single or all occurrences.",
  inputSchema: {
    type: "object",
    required: ["path", "oldString", "newString"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      oldString: { type: "string", description: "Text to find." },
      newString: { type: "string", description: "Text to replace with." },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences (default: false, replaces first only).",
      },
      confirmationToken: {
        type: "string",
        description: "Required when guardrails request confirmation for this edit operation.",
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "edit", "replace", "update"],
    aliases: ["replace_in_file", "modify_file"],
    examples: ["replace text in file", "edit config value"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateEditFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolve(parsed.path);
    const guard = await enforceFilesystemGuard({
      action: "edit",
      path: filePath,
      confirmationToken: parsed.confirmationToken,
    });
    if (!guard.ok) return guard.result;
    const start = Date.now();

    try {
      const content = await readFile(guard.resolvedPath, "utf-8");

      if (!content.includes(parsed.oldString)) {
        return {
          ok: false,
          error: "oldString not found in file.",
          meta: { durationMs: Date.now() - start, filePath: guard.resolvedPath },
        };
      }

      let updated: string;
      let count: number;

      if (parsed.replaceAll) {
        count = content.split(parsed.oldString).length - 1;
        updated = content.replaceAll(parsed.oldString, parsed.newString);
      } else {
        count = 1;
        updated = content.replace(parsed.oldString, parsed.newString);
      }

      await writeFile(guard.resolvedPath, updated, "utf-8");

      return {
        ok: true,
        output: `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${guard.resolvedPath}`,
        meta: { durationMs: Date.now() - start, filePath: guard.resolvedPath, replacements: count },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
