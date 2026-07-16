import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  makeBlock,
  renderContextObservation,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { resolveWorkspaceRoots } from "../../workspace-paths.js";
import { commonAnnotations, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { validateSearchInFilesInput } from "./validators.js";

interface SearchState {
  path: string;
  depth: number;
}

interface FileMatch {
  filePath: string;
  kind: "file";
  line: number;
  before: string[];
  match: string;
  after: string[];
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const DEFAULT_CONTEXT_LINES = 1;
const MAX_CONTEXT_LINES = 5;
const PER_FILE_MATCH_LIMIT = 3;

function containsQuery(text: string, query: string, caseSensitive: boolean): boolean {
  if (caseSensitive) return text.includes(query);
  return text.toLowerCase().includes(query.toLowerCase());
}

function findLineMatches(
  filePath: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  maxMatches: number,
  contextLines: number,
): FileMatch[] {
  const out: FileMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
    const line = lines[i] ?? "";
    if (!containsQuery(line, query, caseSensitive)) {
      continue;
    }
    out.push({
      filePath,
      kind: "file",
      line: i + 1,
      before: lines.slice(Math.max(0, i - contextLines), i),
      match: line,
      after: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)),
    });
  }
  return out;
}

export const searchInFilesTool: ToolDefinition = {
  name: "search_in_files",
  description: "Search text inside files and return bounded structured matches with line context.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Text to search for." },
      roots: {
        type: "array",
        items: { type: "string" },
        description: "Optional absolute directory roots to search. Omit to use the active absolute resource root.",
      },
      maxDepth: { type: "number", description: "Maximum recursion depth (default from guardrails)." },
      maxResults: { type: "number", description: "Maximum number of matching files (default from guardrails)." },
      includeHidden: { type: "boolean", description: "Whether to include hidden files/directories." },
      caseSensitive: { type: "boolean", description: "Whether matching should be case-sensitive." },
      contextLines: { type: "number", description: "Context lines around each match." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["query", "roots", "matchedFileCount", "matchCount", "capped", "matches", "observation"],
    properties: {
      query: { type: "string" },
      roots: { type: "array", items: { type: "string" } },
      matchedFileCount: { type: "integer" },
      matchCount: { type: "integer" },
      capped: { type: "boolean" },
      matches: { type: "array", items: { type: "object" } },
      observation: { type: "object" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: true,
  }),
  observationPolicy: { outputImportance: "decision_context", rawStorage: "always", maxObservationChars: 8_000 },
  resultContract: succeededContract({
    assertions: [{
      id: "matches_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.matches",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "search", "grep", "content", "text"],
    aliases: ["grep_files", "find_text", "content_search"],
    examples: ["search TODO in codebase", "find text in all files"],
    domain: "filesystem-search",
    priority: 35,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateSearchInFilesInput(input);
    if ("ok" in parsed) return parsed;

    const defaultMaxDepth = 10;
    const defaultMaxResults = 500;
    const maxDepth = parsed.maxDepth ?? defaultMaxDepth;
    const maxResults = parsed.maxResults ?? defaultMaxResults;
    const includeHidden = parsed.includeHidden ?? false;
    const caseSensitive = parsed.caseSensitive ?? false;
    const contextLines = Math.max(0, Math.min(parsed.contextLines ?? DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES));
    const roots = resolveWorkspaceRoots(parsed.roots, context?.resourceScope?.rootPath);
    const start = Date.now();

    const searchedRoots: string[] = [];
    const matches: FileMatch[] = [];
    const matchedFiles = new Set<string>();
    let visitedFiles = 0;
    let skippedLargeFiles = 0;

    try {
      for (const root of roots) {
        searchedRoots.push(root);
        const queue: SearchState[] = [{ path: root, depth: 0 }];

        while (queue.length > 0 && matchedFiles.size < maxResults) {
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
            visitedFiles++;
            const info = await stat(fullPath);
            if (info.size > MAX_FILE_SIZE) {
              skippedLargeFiles++;
              continue;
            }

            const content = await readFile(fullPath, "utf-8");
            if (!containsQuery(content, parsed.query, caseSensitive)) continue;

            matchedFiles.add(fullPath);
            matches.push(...findLineMatches(
              fullPath,
              content,
              parsed.query,
              caseSensitive,
              PER_FILE_MATCH_LIMIT,
              contextLines,
            ));

            if (matchedFiles.size >= maxResults) break;
          }
        }
      }

      const capped = matchedFiles.size >= maxResults;
      const observation = buildSearchObservation({
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        matchCount: matches.length,
        capped,
        matches,
        visitedFiles,
        skippedLargeFiles,
        maxDepth,
        maxResults,
        caseSensitive,
      });
      const structuredContent = {
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        matchCount: matches.length,
        capped,
        matches,
        observation,
        visitedFiles,
        skippedLargeFiles,
        maxDepth,
        maxResults,
        caseSensitive,
      };
      const meta = {
        durationMs: Date.now() - start,
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        matchCount: matches.length,
        maxDepth,
        maxResults,
        caseSensitive,
        capped,
      };
      const output = renderContextObservation({
        tool: "search_in_files",
        status: "success",
        message: `Searched ${searchedRoots.length} root${searchedRoots.length === 1 ? "" : "s"}.`,
        observation,
      });
      return {
        ...okResult({
          output,
          meta,
          v2: successV2({
            code: "FILES_SEARCHED",
            message: `Searched files for: ${parsed.query}`,
            structuredContent,
            diagnostics: meta,
          }),
        }),
        rawOutput: formatRawMatches(matches, parsed.query),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem search error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};

function buildSearchObservation(input: {
  query: string;
  roots: string[];
  matchedFileCount: number;
  matchCount: number;
  capped: boolean;
  matches: FileMatch[];
  visitedFiles: number;
  skippedLargeFiles: number;
  maxDepth: number;
  maxResults: number;
  caseSensitive: boolean;
}): ToolContextObservation {
  const blocks = input.matches.slice(0, 12).map((match) => makeBlock({
    title: `${match.filePath}:${match.line}`,
    lines: [
      ...match.before.map((line, index) => `${match.line - match.before.length + index}: ${line}`),
      `${match.line}: ${match.match}`,
      ...match.after.map((line, index) => `${match.line + index + 1}: ${line}`),
    ],
    startLine: Math.max(1, match.line - match.before.length),
    maxChars: 1_000,
    score: 1,
  }));
  return {
    mode: input.capped || input.matches.length > blocks.length ? "large_ref" : "focused",
    summary: input.matchedFileCount > 0
      ? `Found ${input.matchCount} shown match${input.matchCount === 1 ? "" : "es"} in ${input.matchedFileCount} file${input.matchedFileCount === 1 ? "" : "s"} for "${input.query}".`
      : `No matches found for "${input.query}".`,
    stats: {
      query: input.query,
      roots: input.roots.join(", "),
      matchedFileCount: input.matchedFileCount,
      matchCount: input.matchCount,
      visitedFiles: input.visitedFiles,
      skippedLargeFiles: input.skippedLargeFiles,
      maxDepth: input.maxDepth,
      maxResults: input.maxResults,
      caseSensitive: input.caseSensitive,
      capped: input.capped,
    },
    highlights: input.matches.slice(0, 12).map((match) => `${match.filePath}:${match.line}: ${match.match.trim()}`),
    blocks,
    hasMore: input.capped || input.matches.length > blocks.length,
    suggestedReads: [
      { kind: "read_range", reason: "Read exact source lines around a match.", input: {} },
      { kind: "search", reason: "Search within source files for a specific file or term.", input: { query: input.query } },
    ],
  };
}

function formatRawMatches(matches: FileMatch[], query: string): string {
  if (matches.length === 0) {
    return `(no matches for "${query}")`;
  }
  return matches.map((match) => [
    `${match.filePath}:${match.line}: ${match.match}`,
    ...match.before.map((line) => `  before: ${line}`),
    ...match.after.map((line) => `  after: ${line}`),
  ].join("\n")).join("\n\n");
}
