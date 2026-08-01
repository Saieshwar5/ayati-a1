import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspaceRoots } from "../../workspace-paths.js";
import {
  commonAnnotations,
  okResult,
  succeededContract,
  successV2,
} from "../contract-helpers.js";
import { validateFindFilesInput } from "./validators.js";
import type { FindFilesInput } from "./types.js";

interface SearchState {
  path: string;
  depth: number;
}

type MatchKind = "file" | "directory" | "symlink";

interface FindMatch {
  name: string;
  absolutePath: string;
  kind: MatchKind;
}

function matchQuery(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

function hasWildcardSyntax(query: string): boolean {
  return /[*?[\]{}]/.test(query);
}

function matchesKind(actual: MatchKind, requested: NonNullable<FindFilesInput["kind"]>): boolean {
  return requested === "any" || requested === actual;
}

export const findFilesTool: ToolDefinition = {
  name: "find_files",
  description: "Find files, directories, or symbolic links by name across one or more roots with depth and result limits. Symbolic-link directories are reported but never traversed.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "File, directory, or symbolic-link name fragment to search for." },
      kind: {
        type: "string",
        enum: ["file", "directory", "symlink", "any"],
        description: "Kind of path to match. Defaults to any.",
      },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Optional absolute directory roots to search. Omit to use the active absolute resource root.",
      },
      maxDepth: { type: "number", description: "Maximum recursion depth (default from guardrails)." },
      maxResults: { type: "number", description: "Maximum number of matches (default from guardrails)." },
      includeHidden: { type: "boolean", description: "Whether to include hidden files/directories." },
    },
  },
  outputSchema: {
    type: "object",
    required: [
      "query",
      "kind",
      "roots",
      "matches",
      "matchCount",
      "maxDepth",
      "maxResults",
      "includeHidden",
      "capped",
      "errors",
      "errorCount",
      "depthLimitedDirectoryCount",
      "traversalComplete",
    ],
    properties: {
      query: { type: "string" },
      kind: { type: "string", enum: ["file", "directory", "symlink", "any"] },
      roots: { type: "array", items: { type: "string" } },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "absolutePath", "kind"],
          properties: {
            name: { type: "string" },
            absolutePath: { type: "string" },
            kind: { type: "string", enum: ["file", "directory", "symlink"] },
          },
        },
      },
      matchCount: { type: "integer" },
      maxDepth: { type: "integer" },
      maxResults: { type: "integer" },
      includeHidden: { type: "boolean" },
      capped: { type: "boolean" },
      errors: { type: "array", items: { type: "object" } },
      errorCount: { type: "integer" },
      depthLimitedDirectoryCount: { type: "integer" },
      traversalComplete: { type: "boolean" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: true,
  }),
  observationPolicy: {
    outputImportance: "decision_context",
    rawStorage: "always",
    maxObservationChars: 8_000,
  },
  resultContract: succeededContract({
    assertions: [
      {
        id: "matches_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.matches",
      },
      {
        id: "match_count_matches",
        kind: "json_path_number_equals_count",
        path: "$.result.structuredContent.matchCount",
        equalsPath: "$.result.structuredContent.matches",
      },
      {
        id: "search_completeness_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.traversalComplete",
      },
    ],
  }),
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateFindFilesInput(input);
    if ("ok" in parsed) return parsed;

    const defaultMaxDepth = 10;
    const defaultMaxResults = 500;
    const maxDepth = parsed.maxDepth ?? defaultMaxDepth;
    const maxResults = parsed.maxResults ?? defaultMaxResults;
    const includeHidden = parsed.includeHidden ?? false;
    const kind = parsed.kind ?? "any";

    if (hasWildcardSyntax(parsed.query)) {
      return {
        ok: false,
        error: "Invalid input: query contains wildcard syntax. find_files uses plain substring matching; pass query like 'learn1.go'.",
      };
    }

    const roots = resolveWorkspaceRoots(parsed.roots, context?.resourceScope?.rootPath);
    const start = Date.now();
    const matches: FindMatch[] = [];
    const searchedRoots: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];
    let depthLimitedDirectoryCount = 0;

    try {
      for (const root of roots) {
        const rootPath = root;
        searchedRoots.push(rootPath);
        const queue: SearchState[] = [{ path: rootPath, depth: 0 }];

        while (queue.length > 0 && matches.length < maxResults) {
          const current = queue.shift();
          if (!current) break;

          let dirents;
          try {
            dirents = await readdir(current.path, { withFileTypes: true });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown filesystem search error";
            errors.push({ path: current.path, error: message });
            continue;
          }

          for (const dirent of dirents) {
            if (!includeHidden && dirent.name.startsWith(".")) continue;
            const fullPath = join(current.path, dirent.name);
            const matchKind: MatchKind | undefined = dirent.isFile()
              ? "file"
              : dirent.isDirectory()
                ? "directory"
                : dirent.isSymbolicLink()
                  ? "symlink"
                  : undefined;

            if (
              matchKind
              && matchesKind(matchKind, kind)
              && matchQuery(dirent.name, parsed.query)
            ) {
              matches.push({ name: dirent.name, absolutePath: fullPath, kind: matchKind });
              if (matches.length >= maxResults) break;
            }

            if (dirent.isDirectory()) {
              if (current.depth < maxDepth) {
                queue.push({ path: fullPath, depth: current.depth + 1 });
              } else {
                depthLimitedDirectoryCount++;
              }
            }
          }
        }
      }

      const capped = matches.length >= maxResults;
      const traversalComplete = !capped
        && errors.length === 0
        && depthLimitedDirectoryCount === 0;
      const structuredContent = {
        query: parsed.query,
        kind,
        roots: searchedRoots,
        matches,
        matchCount: matches.length,
        maxDepth,
        maxResults,
        includeHidden,
        capped,
        errors: errors.slice(0, 20),
        errorCount: errors.length,
        depthLimitedDirectoryCount,
        traversalComplete,
      };
      const meta = {
        durationMs: Date.now() - start,
        query: parsed.query,
        kind,
        roots: searchedRoots,
        matchCount: matches.length,
        maxDepth,
        maxResults,
        includeHidden,
        capped,
        errorCount: errors.length,
        errors: errors.slice(0, 20),
        depthLimitedDirectoryCount,
        traversalComplete,
      };
      return okResult({
        output: matches.length > 0
          ? matches.map((match) => `[${match.kind}] ${match.absolutePath}`).join("\n")
          : "(no matches)",
        meta,
        v2: successV2({
          code: "FILES_FOUND",
          message: `Found ${matches.length} matching path${matches.length === 1 ? "" : "s"}.`,
          structuredContent,
          diagnostics: meta,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem search error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
