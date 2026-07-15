import type { ArtifactRef, Condition, ToolDefinition, ToolResult } from "../../types.js";
import {
  makeBlock,
  renderContextObservation,
  truncatePreserveLines,
  type ToolContextObservation,
  type ToolContextObservationMode,
} from "../../observations/context-observation.js";
import { commonAnnotations, failureV2, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { readFileCoreTool } from "./read-file-core.js";
import { addFileMetadataAdvisory, fileMetadataAdvisoryCondition } from "./read-advisory.js";
import { splitFileLines } from "./text-lines.js";
import { MAX_READ_FILES, validateReadFilesInput } from "./validators.js";
import type { ReadFileInput } from "./types.js";

const DEFAULT_MAX_PER_FILE_CHARS = 4_000;
const MAX_PER_FILE_CHARS = 20_000;
const DEFAULT_MAX_TOTAL_CHARS = 16_000;
const MAX_TOTAL_CHARS = 60_000;

interface ReadFilesSuccessEntry {
  requestedPath: string;
  ok: true;
  filePath: string;
  mode: string;
  content: string;
  summary: string;
  lineCount?: number;
  lineCountKnown?: boolean;
  truncated: boolean;
  sizeBytes?: number;
  sha256?: string;
  query?: string;
  matchCount?: number;
  startLine?: number;
  endLine?: number;
  observation?: unknown;
}

interface ReadFilesFailureEntry {
  requestedPath: string;
  ok: false;
  error: string;
  code?: string;
}

type ReadFilesEntry = ReadFilesSuccessEntry | ReadFilesFailureEntry;

export const readFilesTool: ToolDefinition = {
  name: "read_files",
  description: "Inspect one or more known text files in one bounded batch. Use this for single-file and multi-file content reads.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: MAX_READ_FILES,
        description: `Files to inspect. Use one entry for a single known file, or up to ${MAX_READ_FILES} related files per call. Split larger reads into another read_files call.`,
        items: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Absolute path, or a relative path. In a task run, relative paths start at the active task root; do not repeat the task directory name. Otherwise they start at the workspace root." },
            mode: {
              type: "string",
              enum: ["auto", "profile", "search", "slice", "full"],
              description: "Read strategy. Defaults to auto, or search when query is provided.",
            },
            query: { type: "string", description: "Text query for search mode or auto-focused reads." },
            startLine: { type: "number", description: "1-based line number for slice mode." },
            lineCount: { type: "number", description: "Maximum number of lines for slice mode." },
            contextLines: { type: "number", description: "Context lines around search matches." },
            maxBlocks: { type: "number", description: "Maximum focused blocks to return." },
          },
        },
      },
      maxPerFileChars: { type: "number", description: "Maximum model-facing characters per file preview." },
      maxTotalChars: { type: "number", description: "Maximum model-facing characters across all file previews." },
      allowMissing: { type: "boolean", description: "Return successful partial output when some files fail to read." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["results", "summary", "observation"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["requestedPath", "ok"],
          properties: {
            requestedPath: { type: "string" },
            ok: { type: "boolean" },
            filePath: { type: "string" },
            mode: { type: "string" },
            content: { type: "string" },
            summary: { type: "string" },
            lineCount: { type: "integer" },
            lineCountKnown: { type: "boolean" },
            truncated: { type: "boolean" },
            sizeBytes: { type: "integer" },
            sha256: { type: "string" },
            query: { type: "string" },
            matchCount: { type: "integer" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            error: { type: "string" },
            code: { type: "string" },
            observation: { type: "object" },
          },
        },
      },
      summary: { type: "object" },
      observation: { type: "object" },
    },
  },
  annotations: commonAnnotations({
    domain: "filesystem",
    readOnly: true,
  }),
  observationPolicy: { outputImportance: "decision_context", rawStorage: "always", maxObservationChars: 16_000 },
  resultContract: succeededContract({
    assertions: [{
      id: "read_files_results_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.results",
    }],
    artifacts: [{ kind: "file", path: "$.result.structuredContent.results[*].filePath" }],
    progressFacts: [{
      kind: "file_read",
      path: "$.result.structuredContent.results[*].filePath",
      message: "Files inspected by read_files.",
    }],
  }),
  selectionHints: {
    tags: ["filesystem", "read", "files", "batch", "content", "grep", "slice", "profile"],
    aliases: ["read_many_files", "batch_read_files", "inspect_files", "open_files"],
    examples: ["read index.html, styles.css, and script.js", "inspect several files before editing"],
    domain: "filesystem",
    priority: 7,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateReadFilesInput(input);
    if ("ok" in parsed) return parsed;

    const maxPerFileChars = clampInt(parsed.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS, 1, MAX_PER_FILE_CHARS);
    const maxTotalChars = clampInt(parsed.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS, 1, MAX_TOTAL_CHARS);
    const start = Date.now();
    const results: ReadFilesEntry[] = [];
    let remainingChars = maxTotalChars;

    for (const file of parsed.files) {
      const result = await readFileCoreTool.execute(file, context);
      if (!result.ok) {
        results.push({
          requestedPath: file.path,
          ok: false,
          error: result.error ?? result.v2?.message ?? "Failed to read file.",
          ...(result.v2?.code ? { code: result.v2.code } : {}),
        });
        continue;
      }

      const structured = asRecord(result.v2?.structuredContent);
      if (!structured) {
        results.push({
          requestedPath: file.path,
          ok: false,
          error: "Internal single-file reader did not return structured content.",
          code: "READ_FILES_ENTRY_STRUCTURED_CONTENT_MISSING",
        });
        continue;
      }

      const content = readString(structured, "content") ?? result.output ?? "";
      const allowedChars = Math.max(0, Math.min(maxPerFileChars, remainingChars));
      const boundedContent = allowedChars > 0 ? truncatePreserveLines(content, allowedChars) : "";
      remainingChars = Math.max(0, remainingChars - boundedContent.length);
      const filePath = readString(structured, "filePath") ?? file.path;
      const observation = compactObservation(structured["observation"]);

      results.push({
        requestedPath: readString(structured, "requestedPath") ?? file.path,
        ok: true,
        filePath,
        mode: readString(structured, "mode") ?? resolveMode(file),
        content: boundedContent,
        summary: observation?.summary ?? `Inspected file: ${filePath}`,
        ...(readNumber(structured, "lineCount") !== undefined ? { lineCount: readNumber(structured, "lineCount") } : {}),
        ...(readBoolean(structured, "lineCountKnown") !== undefined ? { lineCountKnown: readBoolean(structured, "lineCountKnown") } : {}),
        truncated: readBoolean(structured, "truncated") === true || boundedContent.length < content.length || allowedChars === 0,
        ...(readNumber(structured, "sizeBytes") !== undefined ? { sizeBytes: readNumber(structured, "sizeBytes") } : {}),
        ...(readString(structured, "sha256") ? { sha256: readString(structured, "sha256") } : {}),
        ...(readString(structured, "query") ? { query: readString(structured, "query") } : {}),
        ...(readNumber(structured, "matchCount") !== undefined ? { matchCount: readNumber(structured, "matchCount") } : {}),
        ...(readNumber(structured, "startLine") !== undefined ? { startLine: readNumber(structured, "startLine") } : {}),
        ...(readNumber(structured, "endLine") !== undefined ? { endLine: readNumber(structured, "endLine") } : {}),
        ...(observation ? { observation } : {}),
      });
    }

    const successCount = results.filter((entry) => entry.ok).length;
    const failureCount = results.length - successCount;
    const truncatedCount = results.filter((entry) => entry.ok && entry.truncated).length;
    const succeeded = failureCount === 0 || (parsed.allowMissing === true && successCount > 0);
    const status = succeeded ? "success" : "failed";
    const summary = {
      requested: results.length,
      succeeded: successCount,
      failed: failureCount,
      truncated: truncatedCount,
      maxPerFileChars,
      maxTotalChars,
      totalCharsReturned: results
        .filter((entry): entry is ReadFilesSuccessEntry => entry.ok)
        .reduce((total, entry) => total + entry.content.length, 0),
      allowMissing: parsed.allowMissing === true,
    };
    const advisoryReason = readFilesMetadataAdvisoryReason(results, parsed.files);
    const observation = advisoryReason
      ? addFileMetadataAdvisory(buildBatchObservation(results, summary), advisoryReason)
      : buildBatchObservation(results, summary);
    const output = renderContextObservation({
      tool: "read_files",
      status,
      message: succeeded
        ? `Inspected ${successCount}/${results.length} file${results.length === 1 ? "" : "s"}.`
        : `Failed to inspect ${failureCount}/${results.length} file${results.length === 1 ? "" : "s"}.`,
      observation,
      maxChars: maxTotalChars,
    });
    const rawOutput = formatRawOutput(results, maxTotalChars);
    const artifacts: ArtifactRef[] = results
      .filter((entry): entry is ReadFilesSuccessEntry => entry.ok)
      .map((entry) => ({ kind: "file", path: entry.filePath }));
    const meta = {
      durationMs: Date.now() - start,
      requested: summary.requested,
      succeeded: summary.succeeded,
      failed: summary.failed,
      truncated: summary.truncated,
      totalCharsReturned: summary.totalCharsReturned,
    };
    const structuredContent = {
      results,
      summary,
      observation,
    };

    if (!succeeded) {
      const message = successCount > 0
        ? `read_files failed for ${failureCount} file${failureCount === 1 ? "" : "s"}; set allowMissing=true to accept partial reads.`
        : "read_files failed for every requested file.";
      return {
        ok: false,
        output,
        rawOutput,
        error: message,
        meta,
        v2: failureV2({
          code: "READ_FILES_FAILED",
          message,
          category: failureCount === results.length ? "missing_path" : "semantic",
          retryable: true,
          recoverable: true,
          suggestedNextActions: [
            "Correct missing or invalid paths, or set allowMissing=true when partial read output is acceptable.",
          ],
          structuredContent,
          diagnostics: meta,
        }),
      };
    }

    const conditions: Condition[] = [];
    if (failureCount > 0) {
      conditions.push({
        code: "READ_FILES_PARTIAL_FAILURE",
        severity: "warning",
        message: `${failureCount} requested file${failureCount === 1 ? "" : "s"} failed to read.`,
      });
    }
    if (truncatedCount > 0) {
      conditions.push({
        code: "READ_FILES_TRUNCATED",
        severity: "info",
        message: `${truncatedCount} file preview${truncatedCount === 1 ? " was" : "s were"} truncated by batch limits.`,
      });
    }
    if (advisoryReason) {
      conditions.push(fileMetadataAdvisoryCondition(advisoryReason));
    }

    return {
      ...okResult({
        output,
        meta,
        v2: successV2({
          code: failureCount > 0 ? "FILES_INSPECTED_WITH_FAILURES" : "FILES_INSPECTED",
          message: `Inspected ${successCount}/${results.length} file${results.length === 1 ? "" : "s"}.`,
          structuredContent,
          artifacts,
          diagnostics: meta,
          ...(conditions.length > 0 ? { conditions } : {}),
        }),
      }),
      rawOutput,
    };
  },
};

function resolveMode(input: ReadFileInput): string {
  if (input.mode) return input.mode;
  return input.query?.trim() ? "search" : "auto";
}

function readFilesMetadataAdvisoryReason(results: ReadFilesEntry[], requestedFiles: ReadFileInput[]): string | undefined {
  if (results.some((entry) => !entry.ok)) {
    return "Some requested paths failed during a batch content read.";
  }
  if (results.some((entry) => entry.ok && entry.truncated)) {
    return "One or more file previews were truncated by read_files.";
  }
  if (requestedFiles.some((file) => file.mode === "full")) {
    return "The batch requested explicit full reads.";
  }
  if (results.length >= 4) {
    return "The batch read several files at once.";
  }
  if (results.some((entry) => entry.ok && (entry.sizeBytes ?? 0) > 80_000)) {
    return "The batch included medium or large files.";
  }
  return undefined;
}

function buildBatchObservation(
  results: ReadFilesEntry[],
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    truncated: number;
    maxPerFileChars: number;
    maxTotalChars: number;
    totalCharsReturned: number;
    allowMissing: boolean;
  },
): ToolContextObservation {
  const successes = results.filter((entry): entry is ReadFilesSuccessEntry => entry.ok);
  const failures = results.filter((entry): entry is ReadFilesFailureEntry => !entry.ok);
  const blocks = successes.slice(0, 12).map((entry) => makeBlock({
    title: `${entry.filePath} (${entry.mode})`,
    lines: previewLinesForEntry(entry),
    ...(entry.startLine !== undefined ? { startLine: entry.startLine } : {}),
    maxChars: summary.maxPerFileChars,
  }));
  const mode: ToolContextObservationMode = summary.truncated > 0 ? "focused" : "focused";
  return {
    mode,
    summary: `Inspected ${summary.succeeded}/${summary.requested} requested file${summary.requested === 1 ? "" : "s"} in one batch${summary.failed > 0 ? `; ${summary.failed} failed` : ""}.`,
    stats: summary,
    highlights: [
      ...successes.slice(0, 8).map((entry) => [
        `${entry.filePath}: ${entry.summary}`,
        entry.lineCount !== undefined ? `lineCount=${entry.lineCount}` : "",
        entry.sha256 ? `sha256=${entry.sha256}` : "",
      ].filter((part) => part.length > 0).join(" | ")),
      ...failures.slice(0, 4).map((entry) => `${entry.requestedPath}: ${entry.error}`),
    ],
    blocks,
    hasMore: summary.truncated > 0,
    suggestedReads: summary.truncated > 0
      ? [
        { kind: "search", reason: "Search a specific file for the exact selector, symbol, or phrase needed next.", input: {} },
        { kind: "read_range", reason: "Read a precise line range from a truncated file.", input: {} },
      ]
      : [
        { kind: "search", reason: "Search within files only if the batch did not include the relevant location.", input: {} },
      ],
  };
}

function previewLinesForEntry(entry: ReadFilesSuccessEntry): string[] {
  if (entry.content.length > 0) {
    return splitFileLines(entry.content);
  }
  if (entry.lineCount === 0 && !entry.truncated) {
    return ["(empty file)"];
  }
  return ["(content omitted by batch character budget)"];
}

function compactObservation(value: unknown): ToolContextObservation | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const mode = readString(record, "mode");
  if (mode !== "summary" && mode !== "focused" && mode !== "chunk" && mode !== "large_ref") {
    return undefined;
  }
  const stats = asRecord(record["stats"]) ?? {};
  const highlights = Array.isArray(record["highlights"])
    ? record["highlights"].filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];
  const suggestedReads = Array.isArray(record["suggestedReads"])
    ? record["suggestedReads"].filter((item) => item && typeof item === "object").slice(0, 4) as ToolContextObservation["suggestedReads"]
    : undefined;
  return {
    mode,
    summary: readString(record, "summary") ?? "",
    stats,
    highlights,
    blocks: [],
    hasMore: readBoolean(record, "hasMore") === true,
    ...(suggestedReads && suggestedReads.length > 0 ? { suggestedReads } : {}),
  };
}

function formatRawOutput(results: ReadFilesEntry[], maxChars: number): string {
  const sections = results.map((entry) => {
    if (!entry.ok) {
      return `## ${entry.requestedPath}\nFAILED: ${entry.error}`;
    }
    return `## ${entry.filePath}\n${entry.content}`;
  });
  return truncatePreserveLines(sections.join("\n\n---\n\n"), maxChars);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
