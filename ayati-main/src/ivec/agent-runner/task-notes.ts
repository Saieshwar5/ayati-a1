import {
  normalizeWhitespace,
  readContextObservation,
} from "../../skills/observations/context-observation.js";
import type { ActOutput, ActToolCallRecord, TaskNote, ToolObservation } from "../types.js";

const MAX_NEW_NOTES_PER_ACTION = 3;
const NOTE_TEXT_CHARS = 420;

const DURABLE_NOTE_TOOLS = new Set([
  "read_file",
  "search_in_files",
  "find_files",
  "list_directory",
  "dataset_query",
  "document_query",
]);

export function buildTaskNotesFromActOutput(actOutput: ActOutput): TaskNote[] {
  return actOutput.toolCalls
    .flatMap((call): TaskNote[] => {
      const note = buildTaskNote(call);
      return note ? [note] : [];
    })
    .slice(0, MAX_NEW_NOTES_PER_ACTION);
}

function buildTaskNote(call: ActToolCallRecord): TaskNote | undefined {
  if (call.error || call.observation?.status !== "success") {
    return undefined;
  }

  const source = buildNoteSource(call);
  const detail = buildNoteDetail(call, call.observation);
  if (!detail) {
    return undefined;
  }

  return {
    id: buildNoteId(call, source),
    text: truncate(`${source}: ${detail}`, NOTE_TEXT_CHARS),
    source,
    expires: DURABLE_NOTE_TOOLS.has(call.tool) ? "task" : "next_step",
  };
}

function buildNoteDetail(call: ActToolCallRecord, observation: ToolObservation): string | undefined {
  const structuredObservation = readContextObservation(call.result?.structuredContent);
  if (structuredObservation) {
    const highlights = structuredObservation.highlights.slice(0, 3);
    const blockSummaries = structuredObservation.blocks.slice(0, 2).map((block) => {
      const range = block.startLine !== undefined && block.endLine !== undefined
        ? `L${block.startLine}-${block.endLine}`
        : block.title;
      const firstLine = firstUsefulLine(block.content);
      return firstLine ? `${range}: ${firstLine}` : "";
    });
    return uniqueStrings([
      structuredObservation.summary,
      ...highlights,
      ...blockSummaries,
      observation.purpose ? `Purpose: ${observation.purpose}` : undefined,
    ]).join(" ");
  }

  return uniqueStrings([
    observation.purpose ? `Purpose: ${observation.purpose}` : undefined,
    ...renderedObservationLines(observation),
  ]).join(" ");
}

function renderedObservationLines(observation: ToolObservation): string[] {
  return observation.content
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/^[-*]\s+/, "").replace(/^#+\s+/, "")))
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith(`${observation.tool} succeeded`))
    .filter((line) => !line.startsWith("Stats:"))
    .filter((line) => line !== "Highlights:")
    .filter((line) => line !== "Suggested reads:")
    .filter((line) => line !== "More context may be available through narrower domain-tool calls.")
    .slice(0, 4);
}

function buildNoteSource(call: ActToolCallRecord): string {
  const target = readCallTarget(call.input);
  return target ? `${call.tool}:${truncate(target, 180)}` : call.tool;
}

function readCallTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const direct = readFirstString(record, ["path", "filePath", "targetPath", "dirPath", "query", "evidenceRef", "command"]);
  if (direct) {
    return direct;
  }
  const roots = record["roots"];
  if (Array.isArray(roots)) {
    const rootText = roots.filter((item): item is string => typeof item === "string").slice(0, 3).join(",");
    if (rootText) {
      return rootText;
    }
  }
  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeWhitespace(value);
    }
  }
  return undefined;
}

function buildNoteId(call: ActToolCallRecord, source: string): string {
  const base = source === call.tool && call.callId ? `${source}:${call.callId}` : source;
  return `note:${base}`.toLowerCase().replace(/[^a-z0-9._:/-]+/g, "_").slice(0, 160);
}

function firstUsefulLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0) ?? "";
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value ?? "");
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function truncate(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
