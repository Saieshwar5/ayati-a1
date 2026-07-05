import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolObservationPolicy } from "../../skills/types.js";
import {
  readContextObservation,
  renderContextObservation,
} from "../../skills/observations/context-observation.js";
import type { AgentToolCallSpec } from "./decision.js";
import type {
  ActToolCallRecord,
  EvidenceAccessMode,
  ToolObservation,
  ToolObservationRetention,
  WorkEvidenceRef,
} from "../types.js";

const SMALL_OUTPUT_CHARS = 12_000;
const MEDIUM_OUTPUT_CHARS = 120_000;
const CHUNK_CHARS = 8_000;
const RAW_DIR = "raw";

const DECISION_CONTEXT_TOOLS = new Set([
  "shell",
  "shell_run_script",
  "shell_session_write",
  "inspect_paths",
  "read_file",
  "read_files",
  "search_in_files",
  "find_files",
  "list_directory",
]);

const EVIDENCE_TOOLS = new Set([
  "evidence_next_chunk",
  "evidence_search",
  "evidence_read_lines",
  "evidence_tail",
]);

export interface ToolObservationBuildInput {
  runPath: string;
  stepNumber: number;
  call: AgentToolCallSpec;
  record: ActToolCallRecord;
  rawOutput?: string;
  toolDefinition?: ToolDefinition;
}

export interface ToolObservationBuildResult {
  observation?: ToolObservation;
  evidenceRef?: WorkEvidenceRef;
  rawOutputPath?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
}

interface OutputSlice {
  content: string;
  startLine: number;
  endLine: number;
  nextOffset?: number;
}

export async function buildToolObservation(input: ToolObservationBuildInput): Promise<ToolObservationBuildResult> {
  const policy = resolveObservationPolicy(input.toolDefinition, input.call.tool);
  if (policy.outputImportance !== "decision_context") {
    return {};
  }

  const rawOutput = input.rawOutput !== undefined && input.rawOutput.length > 0
    ? input.rawOutput
    : input.record.output ?? "";
  const fallbackContent = input.record.error ? `${input.call.tool} failed: ${input.record.error}` : "";
  const output = rawOutput.length > 0 ? rawOutput : fallbackContent;
  if (output.trim().length === 0) {
    return {};
  }

  const lineCount = countLines(output);
  const existingEvidenceRef = readStructuredString(input.record.result?.structuredContent, "evidenceRef");
  const sourceEvidenceRef = existingEvidenceRef?.startsWith("evidence://")
    ? existingEvidenceRef
    : existingEvidenceRef
      ? `evidence://${existingEvidenceRef}`
      : undefined;
  const maxObservationChars = policy.maxObservationChars ?? CHUNK_CHARS;
  const shouldWriteRaw = shouldStoreRaw(policy, output);
  const evidenceId = buildEvidenceId(input.stepNumber, input.call.id);
  const rawOutputPath = shouldWriteRaw
    ? buildRawOutputPath(input.stepNumber, input.call.id, input.call.tool)
    : readStructuredString(input.record.result?.structuredContent, "rawOutputPath");

  if (shouldWriteRaw && rawOutputPath) {
    await writeRawOutput(input.runPath, rawOutputPath, output);
  }

  const rawOutputChars = output.length;
  const externallyTruncated = readStructuredBoolean(input.record.result?.structuredContent, "truncated")
    ?? readMetaBoolean(input.record.meta, "truncated")
    ?? false;
  const contextObservation = readContextObservation(input.record.result?.structuredContent);
  const structuredMode = readStructuredMode(input.record.result?.structuredContent);
  const mode = contextObservation?.mode ?? structuredMode ?? resolveObservationMode(output.length);
  const slice = mode === "chunk"
    ? readStructuredSlice(input.record.result?.structuredContent, output) ?? sliceLinesByCharBudget(output, 1, maxObservationChars)
    : undefined;
  const content = contextObservation
    ? renderContextObservation({
        tool: input.call.tool,
        status: input.record.error ? "failed" : "success",
        message: input.record.result?.message,
        observation: contextObservation,
        maxChars: maxObservationChars,
      })
    : buildObservationContent({
        tool: input.call.tool,
        record: input.record,
        output,
        mode,
        slice,
        maxChars: maxObservationChars,
      });
  const structuredHasMore = readStructuredBoolean(input.record.result?.structuredContent, "hasMore");
  const hasMore = structuredHasMore ?? (mode === "chunk"
    ? slice?.nextOffset !== undefined
    : (contextObservation?.hasMore ?? mode === "large_ref"));
  const access = resolveAccess(mode, shouldWriteRaw || existingEvidenceRef !== undefined);
  const observationEvidenceRef = sourceEvidenceRef ?? contextObservation?.evidenceRef ?? (shouldWriteRaw && rawOutputPath ? `evidence://${evidenceId}` : undefined);
  const observation: ToolObservation = {
    id: buildObservationId(input.stepNumber, input.call.id),
    step: input.stepNumber,
    callId: input.call.id,
    tool: input.call.tool,
    ...(input.call.purpose ? { purpose: input.call.purpose } : {}),
    status: input.record.error ? "failed" : "success",
    mode,
    retention: resolveRetention(input.call.tool, mode),
    content,
    ...(rawOutputPath ? { rawOutputPath } : {}),
    ...(observationEvidenceRef ? { evidenceRef: observationEvidenceRef } : {}),
    ...(sourceEvidenceRef ? { sourceEvidenceRef } : {}),
    rawOutputChars,
    lineCount,
    hasMore,
    ...(slice ? {
      cursor: {
        currentRange: [slice.startLine, slice.endLine],
        ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
      },
    } : {}),
    ...(access.length > 0 && mode !== "full" ? { availableActions: access.filter((item) => item !== "full") as ToolObservation["availableActions"] } : {}),
  };

  const evidenceRef = shouldWriteRaw && rawOutputPath
    ? {
        id: evidenceId,
        step: input.stepNumber,
        callId: input.call.id,
        tool: input.call.tool,
        title: buildEvidenceTitle(input.call.tool, input.record),
        ref: `evidence://${evidenceId}`,
        rawOutputPath,
        rawOutputChars,
        lineCount,
        truncated: externallyTruncated || mode !== "full",
        access,
      }
    : undefined;

  return {
    observation,
    ...(evidenceRef ? { evidenceRef } : {}),
    ...(rawOutputPath ? { rawOutputPath } : {}),
    rawOutputChars,
    outputTruncated: externallyTruncated || mode !== "full",
  };
}

export function isEvidenceToolName(toolName: string): boolean {
  return EVIDENCE_TOOLS.has(toolName);
}

function resolveObservationPolicy(tool: ToolDefinition | undefined, toolName: string): ToolObservationPolicy {
  if (tool?.observationPolicy) {
    return tool.observationPolicy;
  }
  if (EVIDENCE_TOOLS.has(toolName)) {
    return { outputImportance: "decision_context", rawStorage: "never", maxObservationChars: CHUNK_CHARS };
  }
  if (DECISION_CONTEXT_TOOLS.has(toolName)) {
    return { outputImportance: "decision_context", rawStorage: "always", maxObservationChars: CHUNK_CHARS };
  }
  return { outputImportance: "operation_summary", rawStorage: "never" };
}

function shouldStoreRaw(policy: ToolObservationPolicy, output: string): boolean {
  const rawStorage = policy.rawStorage ?? "always";
  if (rawStorage === "never") {
    return false;
  }
  if (rawStorage === "when_truncated") {
    return output.length > SMALL_OUTPUT_CHARS;
  }
  return output.length > 0;
}

function resolveObservationMode(outputChars: number): ToolObservation["mode"] {
  if (outputChars <= SMALL_OUTPUT_CHARS) {
    return "full";
  }
  if (outputChars <= MEDIUM_OUTPUT_CHARS) {
    return "chunk";
  }
  return "large_ref";
}

function resolveAccess(mode: ToolObservation["mode"], hasRawOutput: boolean): EvidenceAccessMode[] {
  if (!hasRawOutput) {
    return [];
  }
  if (mode === "chunk") {
    return ["next_chunk", "search", "read_lines", "tail"];
  }
  if (mode === "large_ref" || mode === "summary" || mode === "focused") {
    return ["search", "read_lines", "tail"];
  }
  return ["full", "search", "read_lines", "tail"];
}

function resolveRetention(toolName: string, mode: ToolObservation["mode"]): ToolObservationRetention {
  if (EVIDENCE_TOOLS.has(toolName)) {
    return "next_step";
  }
  if (mode === "large_ref") {
    return "evidence_only";
  }
  if (
    toolName === "inspect_paths"
    || toolName === "read_file"
    || toolName === "read_files"
    || toolName === "search_in_files"
    || toolName === "find_files"
    || toolName === "list_directory"
  ) {
    return "while_relevant";
  }
  return "next_step";
}

function buildObservationContent(input: {
  tool: string;
  record: ActToolCallRecord;
  output: string;
  mode: ToolObservation["mode"];
  slice?: OutputSlice;
  maxChars: number;
}): string {
  const statusLine = `${input.tool} ${input.record.error ? "failed" : "succeeded"}${input.record.result?.message ? `: ${input.record.result.message}` : ""}`;
  if (input.mode === "full") {
    return `${statusLine}\n\n${input.output}`.trim();
  }
  if (input.mode === "chunk" && input.slice) {
    return [
      statusLine,
      `Showing lines ${input.slice.startLine}-${input.slice.endLine}.`,
      "",
      input.slice.content,
    ].join("\n").trim();
  }
  return buildSmartPreview(statusLine, input.output, input.maxChars);
}

function buildSmartPreview(statusLine: string, output: string, maxChars: number): string {
  const lines = output.split(/\r?\n/);
  const important = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /error|warn|fail|failed|failure|exception|traceback|typeerror|referenceerror|stderr/i.test(line))
    .slice(0, 40)
    .map(({ line, number }) => `${number}: ${line}`);
  const head = lines.slice(0, 20).map((line, index) => `${index + 1}: ${line}`);
  const tailStart = Math.max(0, lines.length - 40);
  const tail = lines.slice(tailStart).map((line, index) => `${tailStart + index + 1}: ${line}`);
  const sections = [
    statusLine,
    `Large output: ${output.length} chars, ${lines.length} lines.`,
    important.length > 0 ? `Important lines:\n${important.join("\n")}` : "",
    `Head:\n${head.join("\n")}`,
    `Tail:\n${tail.join("\n")}`,
  ].filter((section) => section.trim().length > 0);
  return truncatePreserveLines(sections.join("\n\n"), maxChars);
}

function sliceLinesByCharBudget(output: string, startLine: number, maxChars: number): OutputSlice {
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
  const endLine = Math.max(startLine, startLine + selected.length - 1);
  return {
    content: selected.join("\n"),
    startLine,
    endLine,
    ...(index < lines.length ? { nextOffset: index + 1 } : {}),
  };
}

function buildEvidenceId(stepNumber: number, callId: string): string {
  return `ev_${String(stepNumber).padStart(3, "0")}_${sanitizeSegment(callId)}`;
}

function buildObservationId(stepNumber: number, callId: string): string {
  return `ctx_${String(stepNumber).padStart(3, "0")}_${sanitizeSegment(callId)}`;
}

function buildRawOutputPath(stepNumber: number, callId: string, toolName: string): string {
  return `${RAW_DIR}/${String(stepNumber).padStart(3, "0")}-${sanitizeSegment(callId)}-${sanitizeSegment(toolName)}-output.txt`;
}

function buildEvidenceTitle(toolName: string, record: ActToolCallRecord): string {
  const message = record.result?.message?.trim();
  if (message) {
    return `${toolName}: ${message}`;
  }
  return `${toolName} output`;
}

async function writeRawOutput(runPath: string, rawOutputPath: string, output: string): Promise<void> {
  const absolutePath = join(runPath, rawOutputPath);
  await mkdir(join(runPath, RAW_DIR), { recursive: true });
  await writeFile(absolutePath, output, "utf-8");
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r?\n/).length;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "call";
}

function truncatePreserveLines(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function readStructuredString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function readStructuredBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function readMetaBoolean(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const raw = value?.[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function readStructuredMode(value: unknown): ToolObservation["mode"] | undefined {
  const raw = readStructuredString(value, "mode");
  return raw === "full" || raw === "focused" || raw === "chunk" || raw === "large_ref" || raw === "summary" ? raw : undefined;
}

function readStructuredSlice(value: unknown, content: string): OutputSlice | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const startLine = typeof record["startLine"] === "number" ? Math.trunc(record["startLine"]) : undefined;
  const endLine = typeof record["endLine"] === "number" ? Math.trunc(record["endLine"]) : undefined;
  if (startLine === undefined || endLine === undefined) {
    return undefined;
  }
  const nextOffset = typeof record["nextOffset"] === "number" ? Math.trunc(record["nextOffset"]) : undefined;
  return {
    content,
    startLine,
    endLine,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}
