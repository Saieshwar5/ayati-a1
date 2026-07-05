export type ToolContextObservationMode = "summary" | "focused" | "chunk" | "large_ref";

export interface ToolContextBlock {
  title: string;
  content: string;
  startLine?: number;
  endLine?: number;
  score?: number;
}

export interface ToolSuggestedRead {
  kind: "search" | "read_range" | "read_next_range" | "inspect" | "rerun_narrower" | "list_narrower";
  reason: string;
  input: Record<string, unknown>;
}

export interface ToolContextObservation {
  mode: ToolContextObservationMode;
  summary: string;
  stats: Record<string, unknown>;
  highlights: string[];
  blocks: ToolContextBlock[];
  hasMore: boolean;
  evidenceRef?: string;
  suggestedReads?: ToolSuggestedRead[];
}

export const DEFAULT_OBSERVATION_CHAR_BUDGET = 8_000;
export const DEFAULT_BLOCK_CHAR_BUDGET = 1_200;

export function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r?\n/).length;
}

export function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

export function truncatePreserveLines(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function makeBlock(input: {
  title: string;
  lines: string[];
  startLine?: number;
  maxChars?: number;
  score?: number;
}): ToolContextBlock {
  const maxChars = input.maxChars ?? DEFAULT_BLOCK_CHAR_BUDGET;
  const content = truncatePreserveLines(input.lines.join("\n").trim(), maxChars);
  const lineCount = input.lines.length;
  return {
    title: input.title,
    content,
    ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
    ...(input.startLine !== undefined && lineCount > 0 ? { endLine: input.startLine + lineCount - 1 } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
  };
}

export function headTailBlocks(input: {
  lines: string[];
  headLines?: number;
  tailLines?: number;
  maxBlockChars?: number;
}): ToolContextBlock[] {
  const headLines = input.headLines ?? 20;
  const tailLines = input.tailLines ?? 40;
  const maxBlockChars = input.maxBlockChars ?? DEFAULT_BLOCK_CHAR_BUDGET;
  const blocks: ToolContextBlock[] = [];
  const head = input.lines.slice(0, headLines);
  if (head.length > 0) {
    blocks.push(makeBlock({ title: "Head", lines: head, startLine: 1, maxChars: maxBlockChars }));
  }
  if (input.lines.length > headLines) {
    const tailStart = Math.max(head.length, input.lines.length - tailLines);
    const tail = input.lines.slice(tailStart);
    if (tail.length > 0) {
      blocks.push(makeBlock({ title: "Tail", lines: tail, startLine: tailStart + 1, maxChars: maxBlockChars }));
    }
  }
  return blocks;
}

export function importantLineBlocks(input: {
  lines: string[];
  pattern?: RegExp;
  maxMatches?: number;
  contextLines?: number;
  maxBlockChars?: number;
  title?: string;
}): ToolContextBlock[] {
  const pattern = input.pattern ?? /error|warn|fail|failed|failure|exception|traceback|typeerror|referenceerror|stderr/i;
  const maxMatches = input.maxMatches ?? 12;
  const contextLines = input.contextLines ?? 1;
  const maxBlockChars = input.maxBlockChars ?? DEFAULT_BLOCK_CHAR_BUDGET;
  const blocks: ToolContextBlock[] = [];
  const usedRanges: Array<[number, number]> = [];
  for (let index = 0; index < input.lines.length && blocks.length < maxMatches; index++) {
    if (!pattern.test(input.lines[index] ?? "")) {
      continue;
    }
    const start = Math.max(0, index - contextLines);
    const end = Math.min(input.lines.length - 1, index + contextLines);
    if (usedRanges.some(([from, to]) => start <= to && end >= from)) {
      continue;
    }
    usedRanges.push([start, end]);
    blocks.push(makeBlock({
      title: input.title ?? `Important lines around ${index + 1}`,
      lines: input.lines.slice(start, end + 1),
      startLine: start + 1,
      maxChars: maxBlockChars,
      score: 1,
    }));
  }
  return blocks;
}

export function renderContextObservation(input: {
  tool: string;
  status: "success" | "failed";
  message?: string;
  observation: ToolContextObservation;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? DEFAULT_OBSERVATION_CHAR_BUDGET;
  const lines: string[] = [];
  lines.push(`${input.tool} ${input.status === "failed" ? "failed" : "succeeded"}${input.message ? `: ${input.message}` : ""}`);
  if (input.observation.summary.trim().length > 0) {
    lines.push("", input.observation.summary.trim());
  }

  const statLines = Object.entries(input.observation.stats)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  if (statLines.length > 0) {
    lines.push("", `Stats: ${statLines.join(", ")}`);
  }

  if (input.observation.highlights.length > 0) {
    lines.push("", "Highlights:");
    for (const item of input.observation.highlights.slice(0, 12)) {
      lines.push(`- ${truncatePreserveLines(normalizeWhitespace(item), 220)}`);
    }
  }

  for (const block of input.observation.blocks.slice(0, 8)) {
    const range = block.startLine !== undefined && block.endLine !== undefined
      ? ` lines ${block.startLine}-${block.endLine}`
      : "";
    lines.push("", `## ${block.title}${range}`, block.content);
  }

  if (input.observation.hasMore) {
    lines.push("", "More context may be available through narrower domain-tool calls.");
  }
  if (input.observation.suggestedReads && input.observation.suggestedReads.length > 0) {
    lines.push("", "Suggested reads:");
    for (const read of input.observation.suggestedReads.slice(0, 4)) {
      lines.push(`- ${read.kind}: ${read.reason}`);
    }
  }

  return truncatePreserveLines(lines.join("\n").trim(), maxChars);
}

export function readContextObservation(value: unknown): ToolContextObservation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const rawObservation = record["observation"];
  if (!rawObservation || typeof rawObservation !== "object" || Array.isArray(rawObservation)) {
    return undefined;
  }
  const observation = rawObservation as Record<string, unknown>;
  const mode = observation["mode"];
  if (mode !== "summary" && mode !== "focused" && mode !== "chunk" && mode !== "large_ref") {
    return undefined;
  }
  const summary = typeof observation["summary"] === "string" ? observation["summary"] : "";
  const stats = observation["stats"] && typeof observation["stats"] === "object" && !Array.isArray(observation["stats"])
    ? observation["stats"] as Record<string, unknown>
    : {};
  const highlights = Array.isArray(observation["highlights"])
    ? observation["highlights"].filter((item): item is string => typeof item === "string")
    : [];
  const blocks = Array.isArray(observation["blocks"])
    ? observation["blocks"].flatMap((item): ToolContextBlock[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const block = item as Record<string, unknown>;
        const title = typeof block["title"] === "string" && block["title"].trim().length > 0 ? block["title"] : "Context";
        const content = typeof block["content"] === "string" ? block["content"] : "";
        if (content.trim().length === 0) return [];
        const startLine = typeof block["startLine"] === "number" ? Math.trunc(block["startLine"]) : undefined;
        const endLine = typeof block["endLine"] === "number" ? Math.trunc(block["endLine"]) : undefined;
        const score = typeof block["score"] === "number" ? block["score"] : undefined;
        return [{
          title,
          content,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
          ...(score !== undefined ? { score } : {}),
        }];
      })
    : [];
  const suggestedReads = Array.isArray(observation["suggestedReads"])
    ? observation["suggestedReads"].flatMap((item): ToolSuggestedRead[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const read = item as Record<string, unknown>;
        const kind = read["kind"];
        if (
          kind !== "search"
          && kind !== "read_range"
          && kind !== "read_next_range"
          && kind !== "inspect"
          && kind !== "rerun_narrower"
          && kind !== "list_narrower"
        ) return [];
        const reason = typeof read["reason"] === "string" ? read["reason"] : "";
        const rawInput = read["input"];
        const readInput = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? rawInput as Record<string, unknown>
          : {};
        return [{ kind, reason, input: readInput }];
      })
    : undefined;
  const evidenceRef = typeof observation["evidenceRef"] === "string" ? observation["evidenceRef"] : undefined;
  const hasMore = typeof observation["hasMore"] === "boolean" ? observation["hasMore"] : false;
  return {
    mode,
    summary,
    stats,
    highlights,
    blocks,
    hasMore,
    ...(evidenceRef ? { evidenceRef } : {}),
    ...(suggestedReads && suggestedReads.length > 0 ? { suggestedReads } : {}),
  };
}
