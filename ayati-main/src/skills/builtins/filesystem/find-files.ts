import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateFindFilesInput } from "./validators.js";

interface SearchState {
  path: string;
  depth: number;
}

function matchQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description: "Find files by name across one or more roots with depth and result limits.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "File name fragment to search for." },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Optional roots to search from. Defaults to workspace root.",
      },
      maxDepth: { type: "number", description: "Maximum recursion depth (default from guardrails)." },
      maxResults: { type: "number", description: "Maximum number of matches (default from guardrails)." },
      includeHidden: { type: "boolean", description: "Whether to include hidden files/directories." },
    },
  },
  selectionHints: {
    tags: ["filesystem", "search", "find", "filename", "path"],
    aliases: ["locate_file", "find_path", "find_filename"],
    examples: ["find learn1.go in system", "search for package.json file"],
    domain: "filesystem-search",
    priority: 40,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateFindFilesInput(input);
    if ("ok" in parsed) return parsed;

    const defaultMaxDepth = 10;
    const defaultMaxResults = 500;
    const maxDepth = parsed.maxDepth ?? defaultMaxDepth;
    const maxResults = parsed.maxResults ?? defaultMaxResults;
    const includeHidden = parsed.includeHidden ?? false;

    const roots = (parsed.roots && parsed.roots.length > 0) ? parsed.roots : [process.cwd()];
    const start = Date.now();
    const matches: string[] = [];
    const searchedRoots: string[] = [];

    try {
      for (const root of roots) {
        const rootPath = resolve(root);
        searchedRoots.push(rootPath);
        const queue: SearchState[] = [{ path: rootPath, depth: 0 }];

        while (queue.length > 0 && matches.length < maxResults) {
          const current = queue.shift();
          if (!current) break;

          const dirents = await readdir(current.path, { withFileTypes: true });
          for (const dirent of dirents) {
            if (!includeHidden && dirent.name.startsWith(".")) continue;
            const fullPath = join(current.path, dirent.name);

            if (dirent.isFile() && matchQuery(dirent.name, parsed.query)) {
              matches.push(fullPath);
              if (matches.length >= maxResults) break;
            }

            if (dirent.isDirectory() && current.depth < maxDepth) {
              queue.push({ path: fullPath, depth: current.depth + 1 });
            }
          }
        }
      }

      return {
        ok: true,
        output: matches.length > 0 ? matches.join("\n") : "(no matches)",
        meta: {
          durationMs: Date.now() - start,
          query: parsed.query,
          roots: searchedRoots,
          matchCount: matches.length,
          maxDepth,
          maxResults,
          capped: matches.length >= maxResults,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem search error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
