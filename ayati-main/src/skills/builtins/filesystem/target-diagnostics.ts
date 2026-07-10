import { lineNumberAtOffset, splitFileLines } from "./text-lines.js";

export interface TextTargetDiagnostic {
  targetKind: string;
  reason: string;
  expectedPreview: string;
  hint: string;
  nearestMatchPreview?: string;
  nearestMatchLine?: number;
  matchStrategy?: "whitespace_normalized" | "first_line_anchor" | "last_line_anchor" | "token_overlap";
}

interface IndexedText {
  text: string;
  map: number[];
}

const PREVIEW_LIMIT = 600;

export function buildTextTargetDiagnostic(
  content: string,
  target: string,
  targetKind: string,
): TextTargetDiagnostic {
  const expectedPreview = previewText(target);
  if (target.length === 0) {
    return {
      targetKind,
      reason: `${targetKind} is empty.`,
      expectedPreview,
      hint: `Retry with a non-empty ${targetKind} copied from the latest read output.`,
    };
  }

  const whitespaceMatch = findWhitespaceNormalizedMatch(content, target);
  if (whitespaceMatch) {
    return {
      targetKind,
      reason: `Exact ${targetKind} was not found, but a whitespace-normalized match exists.`,
      expectedPreview,
      nearestMatchPreview: whitespaceMatch.preview,
      nearestMatchLine: whitespaceMatch.line,
      matchStrategy: "whitespace_normalized",
      hint: "Retry with the exact multiline/indented text from nearestMatchPreview, or use replace_lines for that line range.",
    };
  }

  const anchorMatch = findAnchorLineMatch(content, target);
  if (anchorMatch) {
    return {
      targetKind,
      reason: `Exact ${targetKind} was not found, but one boundary line was found nearby.`,
      expectedPreview,
      nearestMatchPreview: anchorMatch.preview,
      nearestMatchLine: anchorMatch.line,
      matchStrategy: anchorMatch.strategy,
      hint: "Read the nearby line range, then retry with a smaller exact target or use replace_lines.",
    };
  }

  const tokenMatch = findTokenOverlapLine(content, target);
  if (tokenMatch) {
    return {
      targetKind,
      reason: `Exact ${targetKind} was not found. The nearest line only partially overlaps.`,
      expectedPreview,
      nearestMatchPreview: tokenMatch.preview,
      nearestMatchLine: tokenMatch.line,
      matchStrategy: "token_overlap",
      hint: "Read the nearby context before retrying; the target may be stale or differently formatted.",
    };
  }

  return {
    targetKind,
    reason: `Exact ${targetKind} was not found in the file.`,
    expectedPreview,
    hint: "Search or read the latest file context, then retry with text copied exactly from the current file.",
  };
}

function findWhitespaceNormalizedMatch(content: string, target: string): { preview: string; line: number } | undefined {
  const haystack = normalizeWhitespaceWithMap(content);
  const needle = normalizeWhitespace(target);
  if (!needle) return undefined;

  const index = haystack.text.indexOf(needle);
  if (index === -1) return undefined;

  const start = haystack.map[index];
  const end = haystack.map[index + needle.length - 1];
  if (start === undefined || end === undefined) return undefined;

  return previewAroundSpan(content, start, end + 1);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeWhitespaceWithMap(value: string): IndexedText {
  let text = "";
  const map: number[] = [];
  let pendingSpaceIndex: number | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (/\s/.test(char)) {
      if (text.length > 0) pendingSpaceIndex ??= index;
      continue;
    }
    if (pendingSpaceIndex !== undefined && text.length > 0) {
      text += " ";
      map.push(pendingSpaceIndex);
    }
    pendingSpaceIndex = undefined;
    text += char;
    map.push(index);
  }

  return { text, map };
}

function findAnchorLineMatch(content: string, target: string): {
  preview: string;
  line: number;
  strategy: "first_line_anchor" | "last_line_anchor";
} | undefined {
  const targetLines = target.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const first = targetLines[0];
  const last = targetLines[targetLines.length - 1];

  if (first) {
    const match = findLineContaining(content, first);
    if (match) return { ...match, strategy: "first_line_anchor" };
  }
  if (last && last !== first) {
    const match = findLineContaining(content, last);
    if (match) return { ...match, strategy: "last_line_anchor" };
  }
  return undefined;
}

function findLineContaining(content: string, needle: string): { preview: string; line: number } | undefined {
  const lines = splitFileLines(content);
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").includes(needle)) {
      return previewAroundLine(lines, index);
    }
  }
  return undefined;
}

function findTokenOverlapLine(content: string, target: string): { preview: string; line: number } | undefined {
  const targetTokens = new Set(tokenize(target));
  if (targetTokens.size === 0) return undefined;

  const lines = splitFileLines(content);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineTokens = tokenize(lines[index] ?? "");
    if (lineTokens.length === 0) continue;
    const overlap = lineTokens.filter((token) => targetTokens.has(token)).length;
    const score = overlap / Math.max(targetTokens.size, 1);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex === -1 || bestScore < 0.35) return undefined;
  return previewAroundLine(lines, bestIndex);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [];
}

function previewAroundSpan(content: string, start: number, end: number): { preview: string; line: number } {
  const lineStart = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndIndex = content.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? content.length : lineEndIndex;
  return {
    preview: previewText(content.slice(lineStart, lineEnd)),
    line: lineNumberAtOffset(content, start),
  };
}

function previewAroundLine(lines: string[], index: number): { preview: string; line: number } {
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return {
    preview: previewText(lines.slice(start, end).join("\n")),
    line: index + 1,
  };
}

function previewText(value: string): string {
  if (value.length <= PREVIEW_LIMIT) return value;
  return `${value.slice(0, PREVIEW_LIMIT)}...[truncated]`;
}
