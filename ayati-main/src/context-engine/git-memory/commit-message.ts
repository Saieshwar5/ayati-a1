import type {
  GitMemoryConversationSeqRange,
  GitMemoryCommitEventType,
  GitMemoryRunId,
  GitMemoryRunStatus,
  GitMemorySessionId,
  GitMemoryTaskId,
} from "./schema.js";

export interface GitMemoryCommitTrailers {
  sessionId?: GitMemorySessionId;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  event?: GitMemoryCommitEventType;
  status?: GitMemoryRunStatus | string;
  at?: string;
  branch?: string;
  conversationSeq?: GitMemoryConversationSeqRange;
  schemaVersion?: 1;
  extras?: Record<string, string | string[] | undefined>;
}

export interface GitMemoryCommitMessageInput {
  subject: string;
  summary?: string;
  completed?: string[];
  open?: string[];
  notes?: string[];
  trailers: GitMemoryCommitTrailers;
}

export interface ParsedGitMemoryCommitTrailers {
  raw: Record<string, string[]>;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  event?: string;
  status?: string;
  at?: string;
  branch?: string;
  conversationSeq?: GitMemoryConversationSeqRange;
  schemaVersion?: number;
}

export function renderGitMemoryCommitMessage(input: GitMemoryCommitMessageInput): string {
  const lines = [normalizeSubject(input.subject)];
  appendNamedParagraph(lines, "Summary", input.summary);
  appendListSection(lines, "Completed", input.completed);
  appendListSection(lines, "Open", input.open);
  appendListSection(lines, "Notes", input.notes);
  const trailers = renderGitMemoryTrailers(input.trailers);
  if (trailers.length > 0) {
    lines.push("", ...trailers);
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function parseGitMemoryCommitTrailers(message: string): ParsedGitMemoryCommitTrailers {
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

  const schemaVersion = first(raw["Ayati-Schema-Version"]);
  const conversationSeq = parseConversationSeq(first(raw["Ayati-Conversation-Seq"]));
  return {
    raw,
    ...(first(raw["Ayati-Session-Id"]) ? { sessionId: first(raw["Ayati-Session-Id"]) } : {}),
    ...(first(raw["Ayati-Task-Id"]) ? { taskId: first(raw["Ayati-Task-Id"]) } : {}),
    ...(first(raw["Ayati-Run-Id"]) ? { runId: first(raw["Ayati-Run-Id"]) } : {}),
    ...(first(raw["Ayati-Event"]) ? { event: first(raw["Ayati-Event"]) } : {}),
    ...(first(raw["Ayati-Status"]) ? { status: first(raw["Ayati-Status"]) } : {}),
    ...(first(raw["Ayati-At"]) ? { at: first(raw["Ayati-At"]) } : {}),
    ...(first(raw["Ayati-Branch"]) ? { branch: first(raw["Ayati-Branch"]) } : {}),
    ...(conversationSeq ? { conversationSeq } : {}),
    ...(schemaVersion ? { schemaVersion: Number(schemaVersion) } : {}),
  };
}

function renderGitMemoryTrailers(trailers: GitMemoryCommitTrailers): string[] {
  const lines: string[] = [];
  appendTrailer(lines, "Ayati-Schema-Version", String(trailers.schemaVersion ?? 1));
  appendTrailer(lines, "Ayati-Session-Id", trailers.sessionId);
  appendTrailer(lines, "Ayati-Task-Id", trailers.taskId);
  appendTrailer(lines, "Ayati-Run-Id", trailers.runId);
  appendTrailer(lines, "Ayati-Event", trailers.event);
  appendTrailer(lines, "Ayati-Status", trailers.status);
  appendTrailer(lines, "Ayati-At", trailers.at);
  appendTrailer(lines, "Ayati-Branch", trailers.branch);
  if (trailers.conversationSeq) {
    appendTrailer(
      lines,
      "Ayati-Conversation-Seq",
      `${trailers.conversationSeq.fromSeq}-${trailers.conversationSeq.toSeq}`,
    );
  }

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

function appendNamedParagraph(lines: string[], title: string, value: string | undefined): void {
  const paragraph = value?.trim();
  if (!paragraph) {
    return;
  }
  lines.push("", `${title}:`, singleLine(paragraph));
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

function parseConversationSeq(value: string | undefined): GitMemoryConversationSeqRange | undefined {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  if (!match) {
    return undefined;
  }
  const fromSeq = Number(match[1]);
  const toSeq = Number(match[2]);
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq) {
    return undefined;
  }
  return { fromSeq, toSeq };
}
