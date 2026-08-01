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

function countQueryOccurrences(
  text: string,
  query: string,
  caseSensitive: boolean,
): number {
  const content = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    count++;
    offset = index + needle.length;
  }
  return count;
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
  description: "Search text inside files. Returns matching paths by default, optional snippets, or a complete occurrence count without matching text.",
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
      maxResults: { type: "number", description: "Maximum number of matching files for paths or snippets mode. Count mode scans the complete allowed scope." },
      includeHidden: { type: "boolean", description: "Whether to include hidden files/directories." },
      caseSensitive: { type: "boolean", description: "Whether matching should be case-sensitive." },
      contextLines: {
        type: "number",
        description: "Context lines around each match when resultMode is snippets.",
      },
      resultMode: {
        type: "string",
        enum: ["paths", "snippets", "count"],
        description: "Return matching paths (default), bounded text snippets, or an exact occurrence count when the complete allowed scope can be scanned.",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["query", "roots", "matchedFileCount", "returnedMatchCount", "totalMatchCount", "minimumMatchCount", "countComplete", "hasMore", "countUnit", "capped", "resultMode", "matches", "observation"],
    properties: {
      query: { type: "string" },
      roots: { type: "array", items: { type: "string" } },
      matchedFileCount: { type: "integer" },
      returnedMatchCount: { type: "integer" },
      totalMatchCount: { type: ["integer", "null"] },
      minimumMatchCount: { type: "integer" },
      countComplete: { type: "boolean" },
      hasMore: { type: "boolean" },
      countUnit: { type: "string", enum: ["occurrences"] },
      capped: { type: "boolean" },
      resultMode: { type: "string", enum: ["paths", "snippets", "count"] },
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
    assertions: [
      {
        id: "matches_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.matches",
      },
      {
        id: "returned_match_count_matches",
        kind: "json_path_number_equals_count",
        path: "$.result.structuredContent.returnedMatchCount",
        equalsPath: "$.result.structuredContent.matches",
      },
    ],
  }),
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateSearchInFilesInput(input);
    if ("ok" in parsed) return parsed;

    const defaultMaxDepth = 10;
    const defaultMaxResults = 500;
    const maxDepth = parsed.maxDepth ?? defaultMaxDepth;
    const maxResults = parsed.maxResults ?? defaultMaxResults;
    const includeHidden = parsed.includeHidden ?? false;
    const caseSensitive = parsed.caseSensitive ?? false;
    const resultMode = parsed.resultMode ?? "paths";
    const contextLines = resultMode === "snippets"
      ? Math.max(0, Math.min(parsed.contextLines ?? DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES))
      : 0;
    const roots = resolveWorkspaceRoots(parsed.roots, context?.resourceScope?.rootPath);
    const start = Date.now();

    const searchedRoots: string[] = [];
    const matches: FileMatch[] = [];
    const matchedFiles = new Set<string>();
    let observedMatchCount = 0;
    let visitedFiles = 0;
    let skippedLargeFiles = 0;

    try {
      for (const root of roots) {
        searchedRoots.push(root);
        const queue: SearchState[] = [{ path: root, depth: 0 }];

        while (
          queue.length > 0
          && (resultMode === "count" || matchedFiles.size < maxResults)
        ) {
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
            const occurrenceCount = countQueryOccurrences(
              content,
              parsed.query,
              caseSensitive,
            );
            if (occurrenceCount === 0) continue;

            matchedFiles.add(fullPath);
            observedMatchCount += occurrenceCount;
            if (resultMode !== "count") {
              matches.push(...findLineMatches(
                fullPath,
                content,
                parsed.query,
                caseSensitive,
                PER_FILE_MATCH_LIMIT,
                contextLines,
              ));
            }

            if (resultMode !== "count" && matchedFiles.size >= maxResults) break;
          }
        }
      }

      const capped = resultMode !== "count" && matchedFiles.size >= maxResults;
      const scanComplete = !capped && skippedLargeFiles === 0;
      const countComplete = scanComplete
        && (resultMode === "count" || observedMatchCount === 0);
      const returnedMatchCount = matches.length;
      const totalMatchCount = countComplete ? observedMatchCount : null;
      const hasMore = resultMode === "count"
        ? !countComplete
        : observedMatchCount > 0
          ? true
          : !countComplete;
      const observation = buildSearchObservation({
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        returnedMatchCount,
        totalMatchCount,
        minimumMatchCount: observedMatchCount,
        countComplete,
        hasMore,
        capped,
        matches,
        visitedFiles,
        skippedLargeFiles,
        maxDepth,
        maxResults,
        includeHidden,
        caseSensitive,
        resultMode,
      });
      const structuredContent = {
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        returnedMatchCount,
        totalMatchCount,
        minimumMatchCount: observedMatchCount,
        countComplete,
        hasMore,
        countUnit: "occurrences",
        capped,
        resultMode,
        matches,
        observation,
        visitedFiles,
        skippedLargeFiles,
        maxDepth,
        maxResults,
        includeHidden,
        caseSensitive,
      };
      const meta = {
        durationMs: Date.now() - start,
        query: parsed.query,
        roots: searchedRoots,
        matchedFileCount: matchedFiles.size,
        returnedMatchCount,
        totalMatchCount,
        minimumMatchCount: observedMatchCount,
        countComplete,
        hasMore,
        countUnit: "occurrences",
        maxDepth,
        maxResults,
        includeHidden,
        caseSensitive,
        capped,
        resultMode,
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
        rawOutput: resultMode === "count"
          ? formatRawCount(parsed.query, totalMatchCount, observedMatchCount)
          : formatRawMatches(matches, parsed.query),
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
  returnedMatchCount: number;
  totalMatchCount: number | null;
  minimumMatchCount: number;
  countComplete: boolean;
  hasMore: boolean;
  capped: boolean;
  matches: FileMatch[];
  visitedFiles: number;
  skippedLargeFiles: number;
  maxDepth: number;
  maxResults: number;
  includeHidden: boolean;
  caseSensitive: boolean;
  resultMode: "paths" | "snippets" | "count";
}): ToolContextObservation {
  const visibleMatches = input.resultMode === "snippets"
    ? input.matches.slice(0, 12)
    : firstMatchPerFile(input.matches).slice(0, 12);
  const blocks = input.resultMode === "snippets"
    ? visibleMatches.map((match) => makeBlock({
        title: `${match.filePath}:${match.line}`,
        lines: [
          ...match.before.map((line, index) => `${match.line - match.before.length + index}: ${line}`),
          `${match.line}: ${match.match}`,
          ...match.after.map((line, index) => `${match.line + index + 1}: ${line}`),
        ],
        startLine: Math.max(1, match.line - match.before.length),
        maxChars: 1_000,
        score: 1,
      }))
    : [];
  return {
    mode: input.hasMore ? "large_ref" : "focused",
    summary: input.matchedFileCount > 0
      ? searchSummary(input)
      : input.countComplete
        ? `No matches found for "${input.query}".`
        : `The search for "${input.query}" is incomplete; no exact total is available.`,
    stats: {
      query: input.query,
      roots: input.roots.join(", "),
      matchedFileCount: input.matchedFileCount,
      returnedMatchCount: input.returnedMatchCount,
      totalMatchCount: input.totalMatchCount,
      minimumMatchCount: input.minimumMatchCount,
      countComplete: input.countComplete,
      hasMore: input.hasMore,
      countUnit: "occurrences",
      visitedFiles: input.visitedFiles,
      skippedLargeFiles: input.skippedLargeFiles,
      maxDepth: input.maxDepth,
      maxResults: input.maxResults,
      includeHidden: input.includeHidden,
      caseSensitive: input.caseSensitive,
      capped: input.capped,
      resultMode: input.resultMode,
    },
    highlights: visibleMatches.map((match) => (
      input.resultMode === "snippets"
        ? `${match.filePath}:${match.line}: ${match.match.trim()}`
        : `${match.filePath}:${match.line}`
    )),
    blocks,
    hasMore: input.hasMore,
    suggestedReads: [
      {
        kind: "read_range",
        reason: "Read exact source lines only when the user needs file content.",
        input: {},
      },
      { kind: "search", reason: "Search within source files for a specific file or term.", input: { query: input.query } },
    ],
  };
}

function searchSummary(input: {
  query: string;
  matchedFileCount: number;
  returnedMatchCount: number;
  totalMatchCount: number | null;
  minimumMatchCount: number;
  countComplete: boolean;
  resultMode: "paths" | "snippets" | "count";
}): string {
  const files = `${input.matchedFileCount} file${input.matchedFileCount === 1 ? "" : "s"}`;
  if (input.countComplete) {
    return `Counted ${input.totalMatchCount ?? 0} occurrence${input.totalMatchCount === 1 ? "" : "s"} in ${files} for "${input.query}".`;
  }
  if (input.resultMode === "count") {
    return `Found at least ${input.minimumMatchCount} occurrence${input.minimumMatchCount === 1 ? "" : "s"} in ${files} for "${input.query}", but the count is incomplete.`;
  }
  return `Returned ${input.returnedMatchCount} sample match${input.returnedMatchCount === 1 ? "" : "es"} from ${files} for "${input.query}"; the total count is incomplete.`;
}

function firstMatchPerFile(matches: FileMatch[]): FileMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.filePath)) return false;
    seen.add(match.filePath);
    return true;
  });
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

function formatRawCount(
  query: string,
  totalMatchCount: number | null,
  minimumMatchCount: number,
): string {
  return totalMatchCount === null
    ? `At least ${minimumMatchCount} occurrences found for "${query}"; the count is incomplete.`
    : `${totalMatchCount} occurrences found for "${query}".`;
}
