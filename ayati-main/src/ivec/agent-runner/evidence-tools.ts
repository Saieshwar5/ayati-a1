import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolAnnotations, ToolDefinition, ToolResult, ToolResultV2 } from "../../skills/types.js";
import type { LoopState, WorkEvidenceRef } from "../types.js";

const CHUNK_CHARS = 8_000;
const MAX_READ_LINES = 240;
const MAX_CONTEXT_LINES = 10;
const MAX_SEARCH_MATCHES = 30;

export function createEvidenceTools(state: LoopState): ToolDefinition[] {
  return [
    {
      name: "evidence_next_chunk",
      description: "Read the next bounded chunk from a saved tool-output evidence ref.",
      inputSchema: evidenceRefInputSchema({ offset: true }),
      annotations: readOnlyAnnotations(),
      observationPolicy: { outputImportance: "decision_context", rawStorage: "never", maxObservationChars: CHUNK_CHARS },
      selectionHints: evidenceSelectionHints("next chunk of saved tool output"),
      execute: async (input) => {
        const parsed = parseEvidenceInput(input);
        if ("error" in parsed) return parsed.error;
        const ref = findEvidenceRef(state, parsed.evidenceRef);
        if (!ref) return missingEvidenceResult(parsed.evidenceRef);
        const text = await readEvidenceText(state.runPath, ref);
        const startLine = parsed.offset ?? nextOffsetForRecentObservation(state, ref) ?? 1;
        const slice = sliceLinesByCharBudget(text, startLine, CHUNK_CHARS);
        return successResult("EVIDENCE_CHUNK_READ", `Read evidence chunk ${ref.ref}.`, slice.content, {
          evidenceRef: ref.ref,
          rawOutputPath: ref.rawOutputPath,
          mode: "chunk",
          startLine: slice.startLine,
          endLine: slice.endLine,
          hasMore: slice.nextOffset !== undefined,
          ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
          lineCount: countLines(text),
        });
      },
    },
    {
      name: "evidence_read_lines",
      description: "Read a bounded line range from a saved tool-output evidence ref.",
      inputSchema: evidenceRefInputSchema({ startLine: true, lineCount: true }),
      annotations: readOnlyAnnotations(),
      observationPolicy: { outputImportance: "decision_context", rawStorage: "never", maxObservationChars: CHUNK_CHARS },
      selectionHints: evidenceSelectionHints("read specific lines from saved tool output"),
      execute: async (input) => {
        const parsed = parseEvidenceInput(input);
        if ("error" in parsed) return parsed.error;
        const ref = findEvidenceRef(state, parsed.evidenceRef);
        if (!ref) return missingEvidenceResult(parsed.evidenceRef);
        const text = await readEvidenceText(state.runPath, ref);
        const totalLines = countLines(text);
        const startLine = Math.max(1, parsed.startLine ?? 1);
        const lineCount = Math.max(1, Math.min(parsed.lineCount ?? 120, MAX_READ_LINES));
        const lines = text.split(/\r?\n/).slice(startLine - 1, startLine - 1 + lineCount);
        const endLine = Math.min(totalLines, startLine + lines.length - 1);
        return successResult("EVIDENCE_LINES_READ", `Read evidence lines ${startLine}-${endLine} from ${ref.ref}.`, lines.join("\n"), {
          evidenceRef: ref.ref,
          rawOutputPath: ref.rawOutputPath,
          mode: "full",
          startLine,
          endLine,
          hasMore: endLine < totalLines,
          lineCount: totalLines,
        });
      },
    },
    {
      name: "evidence_tail",
      description: "Read the tail lines from a saved tool-output evidence ref.",
      inputSchema: evidenceRefInputSchema({ lineCount: true }),
      annotations: readOnlyAnnotations(),
      observationPolicy: { outputImportance: "decision_context", rawStorage: "never", maxObservationChars: CHUNK_CHARS },
      selectionHints: evidenceSelectionHints("read tail of saved tool output"),
      execute: async (input) => {
        const parsed = parseEvidenceInput(input);
        if ("error" in parsed) return parsed.error;
        const ref = findEvidenceRef(state, parsed.evidenceRef);
        if (!ref) return missingEvidenceResult(parsed.evidenceRef);
        const text = await readEvidenceText(state.runPath, ref);
        const allLines = text.split(/\r?\n/);
        const lineCount = Math.max(1, Math.min(parsed.lineCount ?? 120, MAX_READ_LINES));
        const startLine = Math.max(1, allLines.length - lineCount + 1);
        const lines = allLines.slice(startLine - 1);
        return successResult("EVIDENCE_TAIL_READ", `Read evidence tail from ${ref.ref}.`, lines.join("\n"), {
          evidenceRef: ref.ref,
          rawOutputPath: ref.rawOutputPath,
          mode: "full",
          startLine,
          endLine: allLines.length,
          hasMore: startLine > 1,
          lineCount: allLines.length,
        });
      },
    },
    {
      name: "evidence_search",
      description: "Search inside a saved tool-output evidence ref with bounded context lines.",
      inputSchema: {
        type: "object",
        required: ["evidenceRef", "query"],
        properties: {
          evidenceRef: { type: "string" },
          query: { type: "string" },
          contextLines: { type: "number" },
          maxMatches: { type: "number" },
        },
      },
      annotations: readOnlyAnnotations(),
      observationPolicy: { outputImportance: "decision_context", rawStorage: "never", maxObservationChars: CHUNK_CHARS },
      selectionHints: evidenceSelectionHints("search saved tool output"),
      execute: async (input) => {
        const parsed = parseEvidenceInput(input);
        if ("error" in parsed) return parsed.error;
        const query = readString(input, "query");
        if (!query) {
          return failureResult("INVALID_EVIDENCE_QUERY", "Missing required field: query");
        }
        const ref = findEvidenceRef(state, parsed.evidenceRef);
        if (!ref) return missingEvidenceResult(parsed.evidenceRef);
        const text = await readEvidenceText(state.runPath, ref);
        const lines = text.split(/\r?\n/);
        const contextLines = Math.max(0, Math.min(parsed.contextLines ?? 2, MAX_CONTEXT_LINES));
        const maxMatches = Math.max(1, Math.min(parsed.maxMatches ?? 20, MAX_SEARCH_MATCHES));
        const matches: string[] = [];
        const lowerQuery = query.toLowerCase();
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index]!.toLowerCase().includes(lowerQuery)) {
            continue;
          }
          const start = Math.max(0, index - contextLines);
          const end = Math.min(lines.length - 1, index + contextLines);
          const block = lines.slice(start, end + 1).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n");
          matches.push(block);
          if (matches.length >= maxMatches) break;
        }
        const output = matches.length > 0
          ? matches.join("\n\n---\n\n")
          : `No matches for "${query}" in ${ref.ref}.`;
        return successResult("EVIDENCE_SEARCHED", `Searched evidence ${ref.ref}.`, output, {
          evidenceRef: ref.ref,
          rawOutputPath: ref.rawOutputPath,
          mode: "full",
          query,
          matchCount: matches.length,
          hasMore: matches.length >= maxMatches,
          lineCount: lines.length,
        });
      },
    },
  ];
}

function evidenceRefInputSchema(fields: { offset?: boolean; startLine?: boolean; lineCount?: boolean }): Record<string, unknown> {
  return {
    type: "object",
    required: ["evidenceRef"],
    properties: {
      evidenceRef: { type: "string" },
      ...(fields.offset ? { offset: { type: "number" } } : {}),
      ...(fields.startLine ? { startLine: { type: "number" } } : {}),
      ...(fields.lineCount ? { lineCount: { type: "number" } } : {}),
    },
  };
}

function evidenceSelectionHints(example: string): ToolDefinition["selectionHints"] {
  return {
    tags: ["evidence", "observation", "tool-output", "raw-output"],
    aliases: ["saved_output", "observation"],
    examples: [example],
    domain: "general",
    priority: 8,
  };
}

function readOnlyAnnotations(): ToolAnnotations {
  return {
    domain: "general",
    readOnly: true,
    mutatesWorkspace: false,
    mutatesExternalWorld: false,
    destructive: false,
    idempotent: true,
    retrySafe: true,
    longRunning: false,
  };
}

function parseEvidenceInput(input: unknown): { evidenceRef: string; offset?: number; startLine?: number; lineCount?: number; contextLines?: number; maxMatches?: number } | { error: ToolResult } {
  const evidenceRef = readString(input, "evidenceRef") ?? readString(input, "id");
  if (!evidenceRef) {
    return { error: failureResult("INVALID_EVIDENCE_REF", "Missing required field: evidenceRef") };
  }
  return {
    evidenceRef,
    ...readOptionalNumber(input, "offset"),
    ...readOptionalNumber(input, "startLine"),
    ...readOptionalNumber(input, "lineCount"),
    ...readOptionalNumber(input, "contextLines"),
    ...readOptionalNumber(input, "maxMatches"),
  };
}

function readString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalNumber(input: unknown, key: string): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? { [key]: Math.trunc(value) } : {};
}

function findEvidenceRef(state: LoopState, ref: string): WorkEvidenceRef | undefined {
  const normalized = ref.startsWith("evidence://") ? ref : `evidence://${ref}`;
  return (state.workState.evidenceRefs ?? []).find((item) => item.ref === normalized || item.id === ref);
}

async function readEvidenceText(runPath: string, ref: WorkEvidenceRef): Promise<string> {
  return await readFile(join(runPath, ref.rawOutputPath), "utf-8");
}

function nextOffsetForRecentObservation(state: LoopState, ref: WorkEvidenceRef): number | undefined {
  const recent = state.toolContext?.recent ?? [];
  for (let index = recent.length - 1; index >= 0; index--) {
    const observation = recent[index];
    if (observation?.evidenceRef === ref.ref) {
      return observation.cursor?.nextOffset;
    }
  }
  return undefined;
}

function sliceLinesByCharBudget(output: string, startLine: number, maxChars: number): { content: string; startLine: number; endLine: number; nextOffset?: number } {
  const lines = output.split(/\r?\n/);
  const startIndex = Math.max(0, startLine - 1);
  const selected: string[] = [];
  let used = 0;
  let index = startIndex;
  for (; index < lines.length; index++) {
    const next = lines[index]!;
    const nextSize = next.length + 1;
    if (selected.length > 0 && used + nextSize > maxChars) {
      break;
    }
    selected.push(next);
    used += nextSize;
    if (used >= maxChars) {
      index++;
      break;
    }
  }
  return {
    content: selected.join("\n"),
    startLine,
    endLine: Math.max(startLine, startLine + selected.length - 1),
    ...(index < lines.length ? { nextOffset: index + 1 } : {}),
  };
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r?\n/).length;
}

function successResult(code: string, message: string, output: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    ok: true,
    output,
    v2: successV2({ code, message, structuredContent }),
  };
}

function missingEvidenceResult(evidenceRef: string): ToolResult {
  return failureResult("EVIDENCE_NOT_FOUND", `Evidence ref not found for this run: ${evidenceRef}`);
}

function failureResult(code: string, message: string): ToolResult {
  return {
    ok: false,
    error: message,
    output: message,
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code,
      message,
      structuredContent: { message },
      error: {
        category: "missing_path",
        code,
        message,
        retryable: false,
        recoverable: true,
        suggestedNextActions: ["Use one of the evidence refs shown in workState.evidenceRefs."],
      },
    },
  };
}

function successV2(input: { code: string; message: string; structuredContent: unknown }): ToolResultV2 {
  return {
    transportOk: true,
    operationStatus: "succeeded",
    code: input.code,
    message: input.message,
    structuredContent: input.structuredContent,
  };
}
