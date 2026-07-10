import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export type FileLineEnding = "\n" | "\r\n";

export interface FileLineSpan {
  text: string;
  start: number;
  end: number;
}

const LINE_BREAK_PATTERN = /\r\n|\n|\r/g;

export function detectFileLineEnding(content: string): FileLineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function hasTrailingLineBreak(content: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(content);
}

export function splitFileLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r\n|\n|\r/);
  if (hasTrailingLineBreak(content)) {
    lines.pop();
  }
  return lines;
}

export function countFileLines(content: string): number {
  return splitFileLines(content).length;
}

export async function countFileLinesFromPath(path: string): Promise<number> {
  let count = 0;
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const _line of reader) {
    count++;
  }
  return count;
}

export function splitFileLineSpans(content: string): FileLineSpan[] {
  if (content.length === 0) {
    return [];
  }

  const lines: FileLineSpan[] = [];
  const pattern = new RegExp(LINE_BREAK_PATTERN);
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    lines.push({
      text: content.slice(start, match.index),
      start,
      end: match.index,
    });
    start = match.index + match[0].length;
  }

  if (start < content.length) {
    lines.push({
      text: content.slice(start),
      start,
      end: content.length,
    });
  }

  return lines;
}

export function lineNumberAtOffset(content: string, offset: number): number {
  const boundedOffset = Math.max(0, Math.min(offset, content.length));
  const pattern = new RegExp(LINE_BREAK_PATTERN);
  let line = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index >= boundedOffset) {
      break;
    }
    line++;
  }
  return line;
}

export function numberFileLines(lines: string[], startLine: number): string[] {
  return lines.map((line, index) => `${startLine + index}: ${line}`);
}
