import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import {
  headTailBlocks,
  importantLineBlocks,
  makeBlock,
  renderContextObservation,
  splitLines,
  truncatePreserveLines,
  type ToolContextBlock,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, errorResultFromUnknown, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { addFileMetadataAdvisory, fileMetadataAdvisoryCondition } from "./read-advisory.js";
import { validateReadFileInput } from "./validators.js";
import type { ReadFileInput } from "./types.js";

const MAX_FULL_CAPTURE_BYTES = 10 * 1024 * 1024;
const LARGE_FILE_SAMPLE_CHARS = 100_000;
const FULL_CONTENT_CAP_CHARS = 100_000;
const DEFAULT_SLICE_LINES = 160;
const MAX_SLICE_LINES = 500;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 8;
const DEFAULT_MAX_BLOCKS = 8;
const MAX_BLOCKS = 30;

type ReadMode = NonNullable<ReadFileInput["mode"]>;

interface TextSource {
  content: string;
  lines: string[];
  complete: boolean;
  lineCount?: number;
}

interface SearchBlock {
  block: ToolContextBlock;
  matchedLine: number;
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Inspect a text file with bounded profile, search, slice, or explicit capped full-read modes.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Absolute or relative file path." },
      mode: {
        type: "string",
        enum: ["auto", "profile", "search", "slice", "full"],
        description: "Read strategy. Defaults to auto; use search or slice for focused exact context.",
      },
      query: { type: "string", description: "Text query for search mode or auto-focused reads." },
      startLine: { type: "number", description: "1-based line number for slice mode." },
      lineCount: { type: "number", description: "Maximum number of lines for slice mode." },
      contextLines: { type: "number", description: "Context lines around search matches." },
      maxBlocks: { type: "number", description: "Maximum focused blocks to return." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["requestedPath", "filePath", "mode", "content", "observation", "truncated", "sizeBytes"],
    properties: {
      requestedPath: { type: "string" },
      filePath: { type: "string" },
      mode: { type: "string" },
      content: { type: "string" },
      observation: { type: "object" },
      lineCount: { type: "integer" },
      lineCountKnown: { type: "boolean" },
      truncated: { type: "boolean" },
      sizeBytes: { type: "integer" },
      query: { type: "string" },
      matchCount: { type: "integer" },
      startLine: { type: "integer" },
      endLine: { type: "integer" },
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
        id: "read_file_exists",
        kind: "file_exists",
        path: "$.result.structuredContent.filePath",
      },
      {
        id: "read_observation_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.observation",
      },
    ],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.filePath" }],
    progressFacts: [{
      kind: "file_read",
      path: "$.result.structuredContent.filePath",
      message: "File inspected by read_file.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "read", "file", "content", "grep", "slice", "profile"],
    aliases: ["cat_file", "open_file", "inspect_file", "grep_file"],
    examples: ["inspect this file", "search this file for symbol", "read lines 20-80"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateReadFileInput(input);
    if ("ok" in parsed) return parsed;

    const filePath = resolveWorkspacePath(parsed.path);
    const start = Date.now();

    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return errorResult({
          code: "NOT_A_FILE",
          message: `Not a file: ${filePath}`,
          category: "semantic",
          target: filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Use list_directory for directories or choose a regular file path."],
          meta: { durationMs: Date.now() - start, filePath },
        });
      }

      const mode = resolveMode(parsed);
      if (mode === "search" && !parsed.query?.trim()) {
        return errorResult({
          code: "QUERY_REQUIRED",
          message: "read_file search mode requires a non-empty query.",
          category: "validation",
          target: filePath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry with mode=search and a non-empty query, or use mode=profile/slice/full."],
          meta: { durationMs: Date.now() - start, filePath },
        });
      }
      const contextLines = clampInt(parsed.contextLines ?? DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES);
      const maxBlocks = clampInt(parsed.maxBlocks ?? DEFAULT_MAX_BLOCKS, 1, MAX_BLOCKS);
      const source = await loadSource(filePath, info.size, mode);
      const language = inferLanguage(filePath);
      const built = await buildReadOutput({
        parsed,
        mode,
        filePath,
        sizeBytes: info.size,
        source,
        language,
        contextLines,
        maxBlocks,
      });
      const durationMs = Date.now() - start;
      const meta = {
        durationMs,
        filePath,
        mode,
        lineCount: built.lineCount,
        lineCountKnown: built.lineCountKnown,
        truncated: built.truncated,
        sizeBytes: info.size,
      };
      const structuredContent = {
        requestedPath: parsed.path,
        filePath,
        mode,
        content: built.content,
        observation: built.observation,
        lineCount: built.lineCount,
        lineCountKnown: built.lineCountKnown,
        truncated: built.truncated,
        sizeBytes: info.size,
        ...(parsed.query?.trim() ? { query: parsed.query.trim(), matchCount: built.matchCount } : {}),
        ...(built.startLine !== undefined ? { startLine: built.startLine } : {}),
        ...(built.endLine !== undefined ? { endLine: built.endLine } : {}),
      };
      const advisoryReason = fileMetadataAdvisoryReason({
        mode,
        sizeBytes: info.size,
        truncated: built.truncated,
        lineCountKnown: built.lineCountKnown,
      });
      if (advisoryReason) {
        structuredContent.observation = addFileMetadataAdvisory(built.observation, advisoryReason);
      }
      const output = renderContextObservation({
        tool: "read_file",
        status: "success",
        message: `Inspected file: ${filePath}`,
        observation: structuredContent.observation,
      });

      return {
        ...okResult({
          output,
          meta,
          v2: successV2({
            code: "FILE_INSPECTED",
            message: `Inspected file: ${filePath}`,
            structuredContent,
            artifacts: [{ kind: "file", path: filePath }],
            diagnostics: meta,
            ...(advisoryReason ? { conditions: [fileMetadataAdvisoryCondition(advisoryReason)] } : {}),
          }),
        }),
        rawOutput: built.rawOutput,
      };
    } catch (err) {
      return errorResultFromUnknown({
        err,
        fallbackMessage: "Unknown filesystem error",
        target: filePath,
        meta: { durationMs: Date.now() - start, filePath },
      });
    }
  },
};

function resolveMode(input: ReadFileInput): ReadMode {
  if (input.mode) {
    return input.mode;
  }
  return input.query?.trim() ? "search" : "auto";
}

function fileMetadataAdvisoryReason(input: {
  mode: ReadMode;
  sizeBytes: number;
  truncated: boolean;
  lineCountKnown: boolean;
}): string | undefined {
  if (input.truncated || !input.lineCountKnown) {
    return "This read returned truncated or sampled context.";
  }
  if (input.mode === "full" && input.sizeBytes > 80_000) {
    return "This was a large explicit full read.";
  }
  if (input.mode === "auto" && input.sizeBytes > 250_000) {
    return "This was a large automatic read.";
  }
  return undefined;
}

async function loadSource(filePath: string, sizeBytes: number, mode: ReadMode): Promise<TextSource> {
  if (sizeBytes <= MAX_FULL_CAPTURE_BYTES) {
    const content = await readFile(filePath, "utf-8");
    const lines = splitLines(content);
    return { content, lines, complete: true, lineCount: lines.length };
  }

  if (mode === "search" || mode === "slice") {
    return { content: "", lines: [], complete: false };
  }

  const content = await readLeadingChars(filePath, LARGE_FILE_SAMPLE_CHARS);
  return {
    content,
    lines: splitLines(content),
    complete: false,
  };
}

async function buildReadOutput(input: {
  parsed: ReadFileInput;
  mode: ReadMode;
  filePath: string;
  sizeBytes: number;
  source: TextSource;
  language: string;
  contextLines: number;
  maxBlocks: number;
}): Promise<{
  content: string;
  rawOutput: string;
  observation: ToolContextObservation;
  truncated: boolean;
  lineCount?: number;
  lineCountKnown: boolean;
  matchCount?: number;
  startLine?: number;
  endLine?: number;
}> {
  if (input.mode === "search") {
    return await buildSearchOutput(input);
  }
  if (input.mode === "slice") {
    return await buildSliceOutput(input);
  }
  if (input.mode === "full") {
    return buildFullOutput(input);
  }
  return buildProfileOrAutoOutput(input);
}

async function buildSearchOutput(input: {
  parsed: ReadFileInput;
  filePath: string;
  sizeBytes: number;
  source: TextSource;
  language: string;
  contextLines: number;
  maxBlocks: number;
}): Promise<{
  content: string;
  rawOutput: string;
  observation: ToolContextObservation;
  truncated: boolean;
  lineCount?: number;
  lineCountKnown: boolean;
  matchCount: number;
}> {
  const query = input.parsed.query?.trim();
  if (!query) {
    throw new Error("search mode requires query.");
  }

  const search = input.source.complete
    ? searchLoadedLines(input.source.lines, query, input.contextLines, input.maxBlocks)
    : await searchStream(input.filePath, query, input.contextLines, input.maxBlocks);
  const content = search.blocks.map((item) => item.block.content).join("\n\n---\n\n");
  const lineCount = input.source.complete ? input.source.lineCount : search.lineCount;
  const rawOutput = input.source.complete ? input.source.content : content;
  const observation: ToolContextObservation = {
    mode: "focused",
    summary: search.matchCount > 0
      ? `Found ${search.matchCount} matching line${search.matchCount === 1 ? "" : "s"} for "${query}". Showing ${search.blocks.length} focused block${search.blocks.length === 1 ? "" : "s"}.`
      : `No matches found for "${query}".`,
    stats: {
      filePath: input.filePath,
      mode: "search",
      query,
      sizeBytes: input.sizeBytes,
      lineCount,
      lineCountKnown: true,
      matchCount: search.matchCount,
      shownBlocks: search.blocks.length,
    },
    highlights: search.blocks.slice(0, 8).map((item) => `L${item.matchedLine}: ${firstNonEmptyLine(item.block.content)}`),
    blocks: search.blocks.map((item) => item.block),
    hasMore: search.matchCount > search.blocks.length,
    suggestedReads: [
      { kind: "search", reason: "Search the file content for another term.", input: { query } },
      { kind: "read_range", reason: "Read exact lines around a match.", input: {} },
    ],
  };
  return {
    content: content || `(no matches for "${query}")`,
    rawOutput,
    observation,
    truncated: search.matchCount > search.blocks.length,
    lineCount,
    lineCountKnown: true,
    matchCount: search.matchCount,
  };
}

async function buildSliceOutput(input: {
  parsed: ReadFileInput;
  filePath: string;
  sizeBytes: number;
  source: TextSource;
  language: string;
}): Promise<{
  content: string;
  rawOutput: string;
  observation: ToolContextObservation;
  truncated: boolean;
  lineCount?: number;
  lineCountKnown: boolean;
  startLine: number;
  endLine: number;
}> {
  const startLine = Math.max(1, input.parsed.startLine ?? 1);
  const requestedLineCount = clampInt(input.parsed.lineCount ?? DEFAULT_SLICE_LINES, 1, MAX_SLICE_LINES);
  const slice = input.source.complete
    ? sliceLoadedLines(input.source.lines, startLine, requestedLineCount)
    : await sliceStream(input.filePath, startLine, requestedLineCount);
  const numbered = numberLines(slice.lines, slice.startLine);
  const content = numbered.join("\n");
  const endLine = slice.startLine + slice.lines.length - 1;
  const observation: ToolContextObservation = {
    mode: "chunk",
    summary: `Read lines ${slice.startLine}-${endLine} from ${input.filePath}.`,
    stats: {
      filePath: input.filePath,
      mode: "slice",
      sizeBytes: input.sizeBytes,
      startLine: slice.startLine,
      endLine,
      requestedLineCount,
      lineCount: slice.lineCount,
      lineCountKnown: true,
    },
    highlights: [],
    blocks: [makeBlock({ title: "Requested line slice", lines: numbered, startLine: slice.startLine, maxChars: 6_000 })],
    hasMore: endLine < slice.lineCount,
    suggestedReads: [
      { kind: "read_next_range", reason: "Continue with a nearby exact line range.", input: { startLine: endLine + 1 } },
      { kind: "search", reason: "Search this file for specific text.", input: {} },
    ],
  };
  return {
    content,
    rawOutput: content,
    observation,
    truncated: false,
    lineCount: slice.lineCount,
    lineCountKnown: true,
    startLine: slice.startLine,
    endLine,
  };
}

function buildFullOutput(input: {
  filePath: string;
  sizeBytes: number;
  source: TextSource;
  language: string;
}): {
  content: string;
  rawOutput: string;
  observation: ToolContextObservation;
  truncated: boolean;
  lineCount?: number;
  lineCountKnown: boolean;
} {
  const fullContent = input.source.content;
  const content = truncatePreserveLines(fullContent, FULL_CONTENT_CAP_CHARS);
  const truncated = content.length < fullContent.length || !input.source.complete;
  const lines = splitLines(content);
  const observation: ToolContextObservation = {
    mode: truncated ? "large_ref" : "focused",
    summary: truncated
      ? `Explicit full read was capped for ${input.filePath}; use narrower line slices for more.`
      : `Explicit full read returned ${lines.length} line${lines.length === 1 ? "" : "s"} from ${input.filePath}.`,
    stats: {
      filePath: input.filePath,
      mode: "full",
      language: input.language,
      sizeBytes: input.sizeBytes,
      lineCount: input.source.lineCount ?? lines.length,
      lineCountKnown: input.source.complete,
      truncated,
    },
    highlights: extractOutline(input.source.lines, input.language).slice(0, 12).map((item) => `L${item.line}: ${item.text}`),
    blocks: headTailBlocks({ lines, headLines: 30, tailLines: 40, maxBlockChars: 3_000 }),
    hasMore: truncated,
    suggestedReads: [
      { kind: "read_range", reason: "Read an exact file line range.", input: {} },
      { kind: "search", reason: "Search the file content for a symbol or error.", input: {} },
    ],
  };
  return {
    content,
    rawOutput: input.source.complete ? fullContent : content,
    observation,
    truncated,
    lineCount: input.source.lineCount ?? lines.length,
    lineCountKnown: input.source.complete,
  };
}

function buildProfileOrAutoOutput(input: {
  parsed: ReadFileInput;
  mode: ReadMode;
  filePath: string;
  sizeBytes: number;
  source: TextSource;
  language: string;
  maxBlocks: number;
}): {
  content: string;
  rawOutput: string;
  observation: ToolContextObservation;
  truncated: boolean;
  lineCount?: number;
  lineCountKnown: boolean;
} {
  const outline = extractOutline(input.source.lines, input.language);
  const outlineBlocks = outline.length > 0
    ? [makeBlock({
        title: "Code outline",
        lines: outline.slice(0, 80).map((item) => `${item.line}: ${item.text}`),
        maxChars: 4_000,
      })]
    : [];
  const importantBlocks = importantLineBlocks({
    lines: input.source.lines,
    maxMatches: Math.max(1, Math.min(4, input.maxBlocks)),
    contextLines: 1,
    maxBlockChars: 1_200,
  });
  const sampleBlocks = input.mode === "profile"
    ? []
    : headTailBlocks({ lines: input.source.lines, headLines: 24, tailLines: 32, maxBlockChars: 2_000 });
  const blocks = [...outlineBlocks, ...importantBlocks, ...sampleBlocks].slice(0, input.maxBlocks);
  const lineCount = input.source.lineCount ?? input.source.lines.length;
  const observation: ToolContextObservation = {
    mode: input.mode === "profile" ? "summary" : input.source.complete ? "focused" : "large_ref",
    summary: input.source.complete
      ? `Inspected ${input.filePath}: ${lineCount} line${lineCount === 1 ? "" : "s"}, ${input.sizeBytes} bytes.`
      : `Inspected a bounded sample of large file ${input.filePath}: ${input.sizeBytes} bytes; exact full content was not loaded into context.`,
    stats: {
      filePath: input.filePath,
      mode: input.mode,
      language: input.language,
      sizeBytes: input.sizeBytes,
      lineCount,
      lineCountKnown: input.source.complete,
      sampled: !input.source.complete,
      outlineCount: outline.length,
    },
    highlights: outline.slice(0, 12).map((item) => `L${item.line}: ${item.text}`),
    blocks,
    hasMore: !input.source.complete,
    suggestedReads: [
      { kind: "search", reason: "Search for the relevant symbol, error, or term instead of reading the whole file.", input: {} },
      { kind: "read_range", reason: "Read an exact line range once the relevant location is known.", input: {} },
    ],
  };
  const content = blocks.map((block) => block.content).join("\n\n---\n\n") || observation.summary;
  return {
    content,
    rawOutput: input.source.complete ? input.source.content : content,
    observation,
    truncated: !input.source.complete,
    lineCount,
    lineCountKnown: input.source.complete,
  };
}

function searchLoadedLines(lines: string[], query: string, contextLines: number, maxBlocks: number): { blocks: SearchBlock[]; matchCount: number; lineCount: number } {
  const lowerQuery = query.toLowerCase();
  const blocks: SearchBlock[] = [];
  let matchCount = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!(lines[index] ?? "").toLowerCase().includes(lowerQuery)) {
      continue;
    }
    matchCount++;
    if (blocks.length >= maxBlocks) {
      continue;
    }
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    blocks.push({
      matchedLine: index + 1,
      block: makeBlock({
        title: `Match at line ${index + 1}`,
        lines: numberLines(lines.slice(start, end + 1), start + 1),
        startLine: start + 1,
        maxChars: 2_000,
        score: 1,
      }),
    });
  }
  return { blocks, matchCount, lineCount: lines.length };
}

async function searchStream(filePath: string, query: string, contextLines: number, maxBlocks: number): Promise<{ blocks: SearchBlock[]; matchCount: number; lineCount: number }> {
  const lowerQuery = query.toLowerCase();
  const recent: Array<{ line: number; text: string }> = [];
  const pending: Array<{ matchedLine: number; startLine: number; lines: string[]; remainingAfter: number }> = [];
  const blocks: SearchBlock[] = [];
  let matchCount = 0;
  let lineNumber = 0;
  const reader = createInterface({ input: createReadStream(filePath, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of reader) {
    lineNumber++;
    for (const item of pending) {
      if (item.remainingAfter > 0) {
        item.lines.push(line);
        item.remainingAfter--;
      }
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      const item = pending[index]!;
      if (item.remainingAfter === 0) {
        if (blocks.length < maxBlocks) {
          blocks.push({
            matchedLine: item.matchedLine,
            block: makeBlock({
              title: `Match at line ${item.matchedLine}`,
              lines: numberLines(item.lines, item.startLine),
              startLine: item.startLine,
              maxChars: 2_000,
              score: 1,
            }),
          });
        }
        pending.splice(index, 1);
      }
    }
    if (line.toLowerCase().includes(lowerQuery)) {
      matchCount++;
      if (blocks.length + pending.length < maxBlocks) {
        const before = recent.slice(-contextLines);
        pending.push({
          matchedLine: lineNumber,
          startLine: before[0]?.line ?? lineNumber,
          lines: [...before.map((item) => item.text), line],
          remainingAfter: contextLines,
        });
      }
    }
    recent.push({ line: lineNumber, text: line });
    if (recent.length > contextLines) {
      recent.shift();
    }
  }
  for (const item of pending) {
    if (blocks.length < maxBlocks) {
      blocks.push({
        matchedLine: item.matchedLine,
        block: makeBlock({
          title: `Match at line ${item.matchedLine}`,
          lines: numberLines(item.lines, item.startLine),
          startLine: item.startLine,
          maxChars: 2_000,
          score: 1,
        }),
      });
    }
  }
  return { blocks, matchCount, lineCount: lineNumber };
}

function sliceLoadedLines(lines: string[], startLine: number, lineCount: number): { lines: string[]; startLine: number; lineCount: number } {
  const startIndex = Math.max(0, startLine - 1);
  return {
    lines: lines.slice(startIndex, startIndex + lineCount),
    startLine,
    lineCount: lines.length,
  };
}

async function sliceStream(filePath: string, startLine: number, lineCount: number): Promise<{ lines: string[]; startLine: number; lineCount: number }> {
  const selected: string[] = [];
  let lineNumber = 0;
  const endLine = startLine + lineCount - 1;
  const reader = createInterface({ input: createReadStream(filePath, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of reader) {
    lineNumber++;
    if (lineNumber >= startLine && lineNumber <= endLine) {
      selected.push(line);
    }
  }
  return { lines: selected, startLine, lineCount: lineNumber };
}

async function readLeadingChars(filePath: string, maxChars: number): Promise<string> {
  const stream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 64 * 1024 });
  let out = "";
  for await (const chunk of stream) {
    out += chunk;
    if (out.length >= maxChars) {
      stream.destroy();
      break;
    }
  }
  return truncatePreserveLines(out, maxChars);
}

function extractOutline(lines: string[], language: string): Array<{ line: number; text: string }> {
  if (!isCodeLike(language)) {
    return [];
  }
  const pattern = /^\s*(import\s.+|export\s.+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|function\s+\w+|async\s+function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+\w+|from\s+\S+\s+import\s+)/;
  const outline: Array<{ line: number; text: string }> = [];
  for (let index = 0; index < lines.length && outline.length < 200; index++) {
    const line = lines[index] ?? "";
    if (pattern.test(line)) {
      outline.push({ line: index + 1, text: line.trim() });
    }
  }
  return outline;
}

function inferLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript-react",
    ".js": "javascript",
    ".jsx": "javascript-react",
    ".json": "json",
    ".md": "markdown",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".css": "css",
    ".html": "html",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
  };
  return map[ext] ?? (ext ? ext.slice(1) : "text");
}

function isCodeLike(language: string): boolean {
  return [
    "typescript",
    "typescript-react",
    "javascript",
    "javascript-react",
    "python",
    "rust",
    "go",
    "java",
    "css",
    "html",
  ].includes(language);
}

function numberLines(lines: string[], startLine: number): string[] {
  return lines.map((line, index) => `${startLine + index}: ${line}`);
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
