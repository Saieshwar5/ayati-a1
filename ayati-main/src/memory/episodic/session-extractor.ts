import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  AssistantResponseEvent,
  SessionEvent,
  SystemEventEntry,
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
      // Ignore malformed event markers.
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
      // Ignore malformed lines.
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

    const assistant = findFollowingAssistant(events, idx + 1, event.runId);
    if (!assistant) {
      continue;
    }

    const userText = truncateForEmbedding(redactSensitiveText(event.content), MAX_MESSAGE_CHARS);
    const assistantText = truncateForEmbedding(redactSensitiveText(assistant.event.content), MAX_MESSAGE_CHARS);
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
      runId: event.runId,
      eventStartIndex: idx,
      eventEndIndex: assistant.index,
      summary: summarizeExchange(userText, assistantText),
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
  const recentMessages = events
    .filter((event): event is UserMessageEvent | AssistantResponseEvent => (
      event.type === "user_message" || event.type === "assistant_response"
    ))
    .slice(-6);
  const recentSystemEvents = events
    .filter((event): event is SystemEventEntry => event.type === "system_event")
    .slice(-5);

  if (recentMessages.length === 0 && recentSystemEvents.length === 0) {
    return [];
  }

  const lines = [
    "Daily session recent activity",
    `Close reason: ${payload.reason}`,
  ];
  for (const message of recentMessages) {
    if (message.type === "user_message") {
      lines.push(`Recent user: ${message.content}`);
    } else {
      lines.push(`Recent assistant: ${message.content}`);
    }
  }
  for (const event of recentSystemEvents) {
    lines.push(`Recent system event: ${event.source}/${event.event} ${event.summary}`);
  }

  const sourceText = truncateForEmbedding(redactSensitiveText(lines.join("\n")), MAX_SOURCE_CHARS);
  return [buildEpisode(payload, {
    episodeType: "session_summary",
    createdAt: events[events.length - 1]?.ts ?? new Date().toISOString(),
    eventStartIndex: 0,
    eventEndIndex: events.length - 1,
    summary: summarizeSession(recentMessages, recentSystemEvents),
    sourceText,
    embeddingText: sourceText,
  })];
}

function findFollowingAssistant(
  events: SessionEvent[],
  startIndex: number,
  runId: string,
): { event: AssistantResponseEvent; index: number } | null {
  for (let idx = startIndex; idx < events.length; idx++) {
    const event = events[idx];
    if (!event) {
      continue;
    }
    if (event.type === "user_message") {
      return null;
    }
    if (event.type === "assistant_response" && event.runId === runId) {
      return { event, index: idx };
    }
  }
  return null;
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
  recentMessages: Array<UserMessageEvent | AssistantResponseEvent>,
  recentSystemEvents: SystemEventEntry[],
): string {
  const latestMessage = recentMessages[recentMessages.length - 1];
  if (latestMessage) {
    return truncateInline(
      redactSensitiveText(latestMessage.type === "user_message" ? latestMessage.content : latestMessage.content),
      MAX_SUMMARY_CHARS,
    );
  }
  const latestSystemEvent = recentSystemEvents[recentSystemEvents.length - 1];
  if (latestSystemEvent) {
    return truncateInline(redactSensitiveText(latestSystemEvent.summary), MAX_SUMMARY_CHARS);
  }
  return "Daily session summary";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
