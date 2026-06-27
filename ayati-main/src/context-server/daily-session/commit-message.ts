import type { RunId, SessionId, WorkId } from "./ids.js";

export interface AyatiCommitTrailers {
  sessionId?: SessionId;
  workId?: WorkId;
  runId?: RunId;
  status?: string;
  event?: string;
  at?: string;
  extras?: Record<string, string | string[] | undefined>;
}

export interface AyatiCommitMessageInput {
  subject: string;
  summary?: string;
  completed?: string[];
  open?: string[];
  trailers: AyatiCommitTrailers;
}

export interface ParsedAyatiTrailers {
  raw: Record<string, string[]>;
  sessionId?: string;
  workId?: string;
  runId?: string;
  status?: string;
  event?: string;
  at?: string;
}

export function renderAyatiCommitMessage(input: AyatiCommitMessageInput): string {
  const subject = normalizeSubject(input.subject);
  const lines = [subject];
  appendParagraph(lines, input.summary);
  appendListSection(lines, "Completed", input.completed);
  appendListSection(lines, "Open", input.open);
  const trailers = renderAyatiTrailers(input.trailers);
  if (trailers.length > 0) {
    lines.push("", ...trailers);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function parseAyatiCommitTrailers(message: string): ParsedAyatiTrailers {
  const raw: Record<string, string[]> = {};
  for (const line of message.split(/\r?\n/)) {
    const match = /^Ayati-([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = `Ayati-${match[1] ?? ""}`;
    const value = match[2] ?? "";
    raw[key] = [...(raw[key] ?? []), value];
  }
  return {
    raw,
    ...(first(raw["Ayati-Session"]) ? { sessionId: first(raw["Ayati-Session"]) } : {}),
    ...(first(raw["Ayati-Work"]) ? { workId: first(raw["Ayati-Work"]) } : {}),
    ...(first(raw["Ayati-Run"]) ? { runId: first(raw["Ayati-Run"]) } : {}),
    ...(first(raw["Ayati-Status"]) ? { status: first(raw["Ayati-Status"]) } : {}),
    ...(first(raw["Ayati-Event"]) ? { event: first(raw["Ayati-Event"]) } : {}),
    ...(first(raw["Ayati-At"]) ? { at: first(raw["Ayati-At"]) } : {}),
  };
}

function renderAyatiTrailers(trailers: AyatiCommitTrailers): string[] {
  const lines: string[] = [];
  appendTrailer(lines, "Ayati-Session", trailers.sessionId);
  appendTrailer(lines, "Ayati-Work", trailers.workId);
  appendTrailer(lines, "Ayati-Run", trailers.runId);
  appendTrailer(lines, "Ayati-Status", trailers.status);
  appendTrailer(lines, "Ayati-Event", trailers.event);
  appendTrailer(lines, "Ayati-At", trailers.at);
  const extras = trailers.extras ?? {};
  for (const key of Object.keys(extras).sort()) {
    const fullKey = key.startsWith("Ayati-") ? key : `Ayati-${key}`;
    const values = extras[key];
    if (Array.isArray(values)) {
      for (const value of values) appendTrailer(lines, fullKey, value);
    } else {
      appendTrailer(lines, fullKey, values);
    }
  }
  return lines;
}

function appendTrailer(lines: string[], key: string, value: string | undefined): void {
  if (!value?.trim()) {
    return;
  }
  if (!/^Ayati-[A-Za-z0-9-]+$/.test(key)) {
    throw new Error(`Invalid Ayati trailer key: ${key}`);
  }
  lines.push(`${key}: ${singleLine(value)}`);
}

function appendParagraph(lines: string[], value: string | undefined): void {
  const paragraph = value?.trim();
  if (!paragraph) {
    return;
  }
  lines.push("", paragraph);
}

function appendListSection(lines: string[], title: string, values: string[] | undefined): void {
  const items = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (items.length === 0) {
    return;
  }
  lines.push("", `${title}:`, ...items.map((item) => `- ${singleLine(item)}`));
}

function normalizeSubject(subject: string): string {
  const normalized = singleLine(subject);
  if (!normalized) {
    throw new Error("Commit subject is required.");
  }
  return normalized;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function first(values: string[] | undefined): string | undefined {
  return values && values.length > 0 ? values[0] : undefined;
}
