import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateListDirectoryInput } from "./validators.js";

const MAX_ENTRIES = 1000;

interface EntryInfo {
  name: string;
  type: string;
}

async function listEntries(
  dirPath: string,
  recursive: boolean,
  showHidden: boolean,
  prefix: string,
): Promise<EntryInfo[]> {
  const entries: EntryInfo[] = [];
  const dirents = await readdir(dirPath, { withFileTypes: true });

  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    if (entries.length >= MAX_ENTRIES) break;

    const relName = prefix ? join(prefix, dirent.name) : dirent.name;
    const type = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
    entries.push({ name: relName, type });

    if (recursive && dirent.isDirectory() && entries.length < MAX_ENTRIES) {
      const subEntries = await listEntries(
        join(dirPath, dirent.name),
        true,
        showHidden,
        relName,
      );
      for (const sub of subEntries) {
        if (entries.length >= MAX_ENTRIES) break;
        entries.push(sub);
      }
    }
  }

  return entries;
}

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List directory contents with type labels. Supports recursive and hidden file listing.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative directory path." },
      recursive: { type: "boolean", description: "List contents recursively (default: false)." },
      showHidden: { type: "boolean", description: "Show hidden files/directories (default: false)." },
    },
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateListDirectoryInput(input);
    if ("ok" in parsed) return parsed;

    const dirPath = resolve(parsed.path);
    const start = Date.now();

    try {
      const entries = await listEntries(
        dirPath,
        parsed.recursive ?? false,
        parsed.showHidden ?? false,
        "",
      );

      const capped = entries.length >= MAX_ENTRIES;
      const lines = entries.map((e) => `[${e.type}] ${e.name}`);
      const output = capped
        ? lines.join("\n") + `\n...[capped at ${MAX_ENTRIES} entries]`
        : lines.join("\n");

      return {
        ok: true,
        output: output || "(empty directory)",
        meta: {
          durationMs: Date.now() - start,
          dirPath,
          entryCount: entries.length,
          capped,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
