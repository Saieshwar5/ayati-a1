import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateReadFileInput } from "./validators.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_OUTPUT_CHARS = 100_000;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read text file contents. Supports line offset/limit for large files.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      offset: { type: "number", description: "Line number to start reading from (0-based)." },
      limit: { type: "number", description: "Maximum number of lines to read." },
    },
  },
  selectionHints: {
    tags: ["filesystem", "read", "file", "content"],
    aliases: ["cat_file", "open_file"],
    examples: ["read this file", "show file content"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateReadFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolve(parsed.path);
    const start = Date.now();

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { ok: false, error: `Not a file: ${filePath}`, meta: { durationMs: Date.now() - start } };
      }
      if (info.size > MAX_FILE_SIZE) {
        return {
          ok: false,
          error: `File too large: ${(info.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit.`,
          meta: { durationMs: Date.now() - start },
        };
      }

      const raw = await readFile(filePath, "utf-8");
      let lines = raw.split("\n");

      if (parsed.offset !== undefined) {
        lines = lines.slice(parsed.offset);
      }
      if (parsed.limit !== undefined) {
        lines = lines.slice(0, parsed.limit);
      }

      let output = lines.join("\n");
      let truncated = false;

      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]";
        truncated = true;
      }

      return {
        ok: true,
        output,
        meta: {
          durationMs: Date.now() - start,
          filePath,
          lineCount: lines.length,
          truncated,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
