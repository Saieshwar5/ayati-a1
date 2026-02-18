import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateWriteFileInput } from "./validators.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write or overwrite a file. Optionally creates parent directories.",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      content: { type: "string", description: "Content to write." },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist (default: false).",
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "write", "create", "file"],
    aliases: ["save_file", "overwrite_file"],
    examples: ["write content to file", "create file with text"],
    domain: "filesystem",
    priority: 3,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateWriteFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolve(parsed.path);
    const start = Date.now();

    try {
      if (parsed.createDirs) {
        await mkdir(dirname(filePath), { recursive: true });
      }

      await writeFile(filePath, parsed.content, "utf-8");

      return {
        ok: true,
        output: `Written ${parsed.content.length} characters to ${filePath}`,
        meta: {
          durationMs: Date.now() - start,
          filePath,
          bytesWritten: Buffer.byteLength(parsed.content, "utf-8"),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
