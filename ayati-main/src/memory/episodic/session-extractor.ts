import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  AssistantFeedbackEvent,
  AssistantMessageEvent,
  SessionCloseEvent,
  SessionEvent,
  TaskSummaryEvent,
  UserMessageEvent,
} from "../session-events.js";
import { deserializeEvent } from "../session-events.js";
import type {
  EpisodicMemoryEpisode,
  EpisodicMemoryEpisodeType,
  EpisodicSessionIndexPayload,
} from "./types.js";

const EVENT_MARKER = "AYATI_EVENT";
const MAX_MESSAGE_CHARS = 2_400;
const MAX_SOURCE_CHARS = 6_000;
const MAX_SUMMARY_CHARS = 700;

export function extractEpisodicEpisodesFromSessionFile(payload: EpisodicSessionIndexPayload): EpisodicMemoryEpisode[] {
  let content = "";
  try {
    content = readFileSync(payload.sessionFilePath, "utf8");
  } catch {
    return [];
  }
  return extractEpisodicEpisodes(payload, parseSessionEventsFromContent(content));
}

export function extractEpisodicEpisodes(
  payload: EpisodicSessionIndexPayload,
  events: SessionEvent[],
): EpisodicMemoryEpisode[] {
  if (events.length === 0) {
    return [];
  }

  return [
    ...extractConversationExchanges(payload, events),
    ...extractTaskOutcomes(payload, events),
    ...extractSessionSummary(payload, events),
  ];
}

export function parseSessionEventsFromContent(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  const markerPattern = new RegExp(`<!--\\s*${EVENT_MARKER}\\s+(.+?)\\s*-->`, "g");
  let match: RegExpExecArray | null = null;
  while ((match = markerPattern.exec(content)) !== null) {
    const payload = match[1];
    if (!payload) continue;
    try {
      events.push(deserializeEvent(payload));
    } catch {
      // Ignore malformed event markers; session replay does the same.
    }
  }

  if (events.length > 0) {
    return events;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(deserializeEvent(trimmed));
    } catch {
      // Ignore malformed legacy lines.
    }
  }
  return events;
}

function extractConversationExchanges(
  payload: EpisodicSessionIndexPayload,
  events: SessionEvent[],
): EpisodicMemoryEpisode[] {
  const episodes: EpisodicMemoryEpisode[] = [];

  for (let idx = 0; idx < events.length; idx++) {
    const event = events[idx];
    if (!event || event.type !== "user_message") {
      continue;
    }

    const assistant = findFollowingAssistant(events, idx + 1);
    if (!assistant) {
      continue;
    }

    const userText = truncateForEmbedding(redactSensitiveText(event.content), MAX_MESSAGE_CHARS);
    const assistantText = truncateForEmbedding(
      redactSensitiveText(assistant.event.type === "assistant_message" ? assistant.event.content : assistant.event.message),
      MAX_MESSAGE_CHARS,
    );
    if (!hasUsefulText(userText) && !hasUsefulText(assistantText)) {
      continue;
    }

    const sourceText = truncateForEmbedding([
      "Conversation exchange",
      `User: ${userText}`,
      `Assistant: ${assistantText}`,
    ].join("\n"), MAX_SOURCE_CHARS);
    episodes.push(buildEpisode(payload, {
      episodeType: "conversation_exchange",
      createdAt: assistant.event.ts,
      runId: event.runId ?? (assistant.event.type === "assistant_message" ? assistant.event.runId : undefined),
      eventStartIndex: idx,
      eventEndIndex: assistant.index,
      summary: summarizeExchange(userText, assistantText),
      sourceText,
      embeddingText: sourceText,
    }));
  }

  return episodes;
}

function extractTaskOutcomes(
  payload: EpisodicSessionIndexPayload,
  events: SessionEvent[],
): EpisodicMemoryEpisode[] {
  const episodes: EpisodicMemoryEpisode[] = [];

  for (let idx = 0; idx < events.length; idx++) {
    const event = events[idx];
    if (!event || event.type !== "task_summary") {
      continue;
    }

    const sourceText = truncateForEmbedding(redactSensitiveText(formatTaskSummary(event)), MAX_SOURCE_CHARS);
    if (!hasUsefulText(sourceText)) {
      continue;
    }

    episodes.push(buildEpisode(payload, {
      episodeType: "task_outcome",
      createdAt: event.ts,
      runId: event.runId,
      eventStartIndex: idx,
      eventEndIndex: idx,
      summary: truncateInline(redactSensitiveText(event.summary), MAX_SUMMARY_CHARS),
      sourceText,
      embeddingText: sourceText,
    }));
  }

  return episodes;
}

function extractSessionSummary(
  payload: EpisodicSessionIndexPayload,
  events: SessionEvent[],
): EpisodicMemoryEpisode[] {
  const closeIndex = events.findIndex((event) => event.type === "session_close");
  const closeEvent = closeIndex >= 0 ? events[closeIndex] as SessionCloseEvent : null;
  const handoffSummary = closeEvent?.handoffSummary ?? payload.handoffSummary ?? null;
  const recentTasks = events
    .filter((event): event is TaskSummaryEvent => event.type === "task_summary")
    .slice(-3);
  const recentMessages = events
    .filter((event): event is UserMessageEvent | AssistantMessageEvent | AssistantFeedbackEvent => (
      event.type === "user_message" || event.type === "assistant_message" || event.type === "assistant_feedback"
    ))
    .slice(-6);

  if (!handoffSummary && recentTasks.length === 0 && recentMessages.length === 0) {
    return [];
  }

  const lines = [
    "Session summary",
    `Close reason: ${closeEvent?.reason ?? payload.reason}`,
  ];
  if (handoffSummary?.trim()) {
    lines.push(`Handoff: ${handoffSummary.trim()}`);
  }
  for (const task of recentTasks) {
    lines.push(`Task: ${task.summary}`);
    if (task.nextAction?.trim()) {
      lines.push(`Next action: ${task.nextAction}`);
    }
    if (task.blockers && task.blockers.length > 0) {
      lines.push(`Blockers: ${task.blockers.join("; ")}`);
    }
  }
  for (const message of recentMessages) {
    if (message.type === "user_message") {
      lines.push(`Recent user: ${message.content}`);
    } else if (message.type === "assistant_message") {
      lines.push(`Recent assistant: ${message.content}`);
    } else {
      lines.push(`Recent assistant feedback: ${message.message}`);
    }
  }

  const sourceText = truncateForEmbedding(redactSensitiveText(lines.join("\n")), MAX_SOURCE_CHARS);
  return [buildEpisode(payload, {
    episodeType: "session_summary",
    createdAt: closeEvent?.ts ?? events[events.length - 1]?.ts ?? new Date().toISOString(),
    eventStartIndex: 0,
    eventEndIndex: closeIndex >= 0 ? closeIndex : events.length - 1,
    summary: summarizeSession(handoffSummary, recentTasks, recentMessages),
    sourceText,
    embeddingText: sourceText,
  })];
}

function findFollowingAssistant(
  events: SessionEvent[],
  startIndex: number,
): { event: AssistantMessageEvent | AssistantFeedbackEvent; index: number } | null {
  for (let idx = startIndex; idx < events.length; idx++) {
    const event = events[idx];
    if (!event) {
      continue;
    }
    if (event.type === "user_message") {
      return null;
    }
    if (event.type === "assistant_message" || event.type === "assistant_feedback") {
      return { event, index: idx };
    }
  }
  return null;
}

function formatTaskSummary(event: TaskSummaryEvent): string {
  return [
    "Task outcome",
    `Status: ${event.status}`,
    event.taskStatus ? `Task status: ${event.taskStatus}` : "",
    event.objective ? `Objective: ${event.objective}` : "",
    `Summary: ${event.summary}`,
    event.progressSummary ? `Progress: ${event.progressSummary}` : "",
    event.currentFocus ? `Current focus: ${event.currentFocus}` : "",
    event.userMessage ? `User asked: ${event.userMessage}` : "",
    event.assistantResponse ? `Assistant response: ${event.assistantResponse}` : "",
    event.approach ? `Approach: ${event.approach}` : "",
    joinList("Completed", event.completedMilestones),
    joinList("Open work", event.openWork),
    joinList("Blockers", event.blockers),
    joinList("Key facts", event.keyFacts),
    joinList("Evidence", event.evidence),
    event.userInputNeeded ? `User input needed: ${event.userInputNeeded}` : "",
    event.nextAction ? `Next action: ${event.nextAction}` : "",
    joinList("Attachments", event.attachmentNames),
  ].filter((line) => line.trim().length > 0).join("\n");
}

function buildEpisode(
  payload: EpisodicSessionIndexPayload,
  input: {
    episodeType: EpisodicMemoryEpisodeType;
    createdAt: string;
    runId?: string;
    eventStartIndex: number;
    eventEndIndex: number;
    summary: string;
    sourceText: string;
    embeddingText: string;
  },
): EpisodicMemoryEpisode {
  const stableKey = `${payload.clientId}:${payload.sessionId}:${input.episodeType}:${input.eventStartIndex}:${input.eventEndIndex}`;
  const episodeId = `episode:${sha256(stableKey).slice(0, 24)}`;
  const contentHash = sha256([
    stableKey,
    input.summary,
    input.embeddingText,
  ].join("\n"));

  return {
    episodeId,
    clientId: payload.clientId,
    sessionId: payload.sessionId,
    sessionPath: payload.sessionPath,
    sessionFilePath: payload.sessionFilePath,
    ...(input.runId ? { runId: input.runId } : {}),
    episodeType: input.episodeType,
    createdAt: input.createdAt,
    eventStartIndex: input.eventStartIndex,
    eventEndIndex: input.eventEndIndex,
    summary: truncateInline(input.summary, MAX_SUMMARY_CHARS),
    sourceText: input.sourceText,
    embeddingText: input.embeddingText,
    contentHash,
  };
}

function summarizeExchange(userText: string, assistantText: string): string {
  return truncateInline(`User: ${userText} Assistant: ${assistantText}`, MAX_SUMMARY_CHARS);
}

function summarizeSession(
  handoffSummary: string | null,
  recentTasks: TaskSummaryEvent[],
  recentMessages: Array<UserMessageEvent | AssistantMessageEvent | AssistantFeedbackEvent>,
): string {
  if (handoffSummary?.trim()) {
    return truncateInline(redactSensitiveText(handoffSummary), MAX_SUMMARY_CHARS);
  }
  const latestTask = recentTasks[recentTasks.length - 1];
  if (latestTask) {
    return truncateInline(redactSensitiveText(latestTask.summary), MAX_SUMMARY_CHARS);
  }
  const latestMessage = recentMessages[recentMessages.length - 1];
  if (!latestMessage) {
    return "Session summary";
  }
  const content = latestMessage.type === "user_message"
    ? latestMessage.content
    : (latestMessage.type === "assistant_message" ? latestMessage.content : latestMessage.message);
  return truncateInline(redactSensitiveText(content), MAX_SUMMARY_CHARS);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s,;]{6,}["']?/gi, "$1=[REDACTED_SECRET]");
}

function truncateForEmbedding(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 15).trimEnd()} [truncated]`;
}

function truncateInline(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 15).trimEnd()} [truncated]`;
}

function hasUsefulText(value: string): boolean {
  return value.replace(/\[REDACTED_[^\]]+\]/g, "").trim().length > 0;
}

function joinList(label: string, values?: string[]): string {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return cleaned.length > 0 ? `${label}: ${cleaned.join("; ")}` : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
