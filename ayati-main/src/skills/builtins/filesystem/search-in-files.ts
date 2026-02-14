import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { enforceFilesystemGuard, getFilesystemSearchLimits } from "../../guardrails/index.js";
import { validateSearchInFilesInput } from "./validators.js";

interface SearchState {
  path: string;
  depth: number;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

function containsQuery(text: string, query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return text.includes(query);
  return text.toLowerCase().includes(query.toLowerCase());
}

function findLineMatches(
  content: string,
  query: string,
  caseSensitive: boolean,
  maxMatches: number,
): Array<{ line: number; snippet: string }> {
  const out: Array<{ line: number; snippet: string }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
    const line = lines[i] ?? "";
    if (containsQuery(line, query, caseSensitive)) {
      out.push({ line: i + 1, snippet: line.slice(0, 200) });
    }
  }
  return out;
}

export const searchInFilesTool: ToolDefinition = {
  name: "search_in_files",
  description: "Search text inside files across one or more roots with depth and result limits.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Text to search for." },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Optional roots to search from. Defaults to workspace root.",
      },
      maxDepth: { type: "number", description: "Maximum recursion depth (default from guardrails)." },
      maxResults: { type: "number", description: "Maximum number of matching files (default from guardrails)." },
      includeHidden: { type: "boolean", description: "Whether to include hidden files/directories." },
      caseSensitive: { type: "boolean", description: "Whether matching should be case-sensitive." },
    },
  },
  selectionHints: {
    tags: ["filesystem", "search", "grep", "content", "text"],
    aliases: ["grep_files", "find_text", "content_search"],
    examples: ["search TODO in codebase", "find text in all files"],
    domain: "filesystem-search",
    priority: 35,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateSearchInFilesInput(input);
    if ("ok" in parsed) return parsed;

    const limits = getFilesystemSearchLimits();
    const maxDepth = Math.min(parsed.maxDepth ?? limits.maxDepth, limits.maxDepth);
    const maxResults = Math.min(parsed.maxResults ?? limits.maxResults, limits.maxResults);
    const includeHidden = parsed.includeHidden ?? false;
    const caseSensitive = parsed.caseSensitive ?? false;
    const roots = (parsed.roots && parsed.roots.length > 0) ? parsed.roots : [process.cwd()];
    const start = Date.now();

    const lines: string[] = [];
    const searchedRoots: string[] = [];
    let matchedFiles = 0;

    try {
      for (const root of roots) {
        const rootPath = resolve(root);
        const guard = await enforceFilesystemGuard({ action: "list", path: rootPath });
        if (!guard.ok) continue;

        searchedRoots.push(guard.resolvedPath);
        const queue: SearchState[] = [{ path: guard.resolvedPath, depth: 0 }];

        while (queue.length > 0 && matchedFiles < maxResults) {
          const current = queue.shift();
          if (!current) break;

          const dirents = await readdir(current.path, { withFileTypes: true });
          for (const dirent of dirents) {
            if (!includeHidden && dirent.name.startsWith(".")) continue;
            const fullPath = join(current.path, dirent.name);

            if (dirent.isDirectory()) {
              if (current.depth < maxDepth) {
                queue.push({ path: fullPath, depth: current.depth + 1 });
              }
              continue;
            }

            if (!dirent.isFile()) continue;
            const info = await stat(fullPath);
            if (info.size > MAX_FILE_SIZE) continue;

            const content = await readFile(fullPath, "utf-8");
            if (!containsQuery(content, parsed.query, caseSensitive)) continue;

            matchedFiles++;
            const fileMatches = findLineMatches(content, parsed.query, caseSensitive, 3);
            if (fileMatches.length === 0) {
              lines.push(`${fullPath}`);
            } else {
              lines.push(`${fullPath}`);
              for (const match of fileMatches) {
                lines.push(`  L${match.line}: ${match.snippet}`);
              }
            }

            if (matchedFiles >= maxResults) break;
          }
        }
      }

      return {
        ok: true,
        output: lines.length > 0 ? lines.join("\n") : "(no matches)",
        meta: {
          durationMs: Date.now() - start,
          query: parsed.query,
          roots: searchedRoots,
          matchedFiles,
          maxDepth,
          maxResults,
          caseSensitive,
          capped: matchedFiles >= maxResults,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem search error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
