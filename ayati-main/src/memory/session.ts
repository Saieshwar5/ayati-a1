import type {
  AssistantResponseEvent,
  SessionEvent,
  SystemEventEntry,
  UserMessageEvent,
} from "./session-events.js";
import type { ConversationExchange, ConversationTurn, SystemActivityItem } from "./types.js";

export type SessionTimelineEntry = UserMessageEvent | AssistantResponseEvent | SystemEventEntry;

export class InMemorySession {
  readonly id: string;
  readonly clientId: string;
  readonly startedAt: string;
  readonly sessionPath: string;
  readonly sessionDate: string;
  lastActivityAt: string;
  timeline: SessionTimelineEntry[] = [];

  constructor(
    id: string,
    clientId: string,
    startedAt: string,
    sessionPath: string,
    sessionDate: string,
  ) {
    this.id = id;
    this.clientId = clientId;
    this.startedAt = startedAt;
    this.sessionPath = sessionPath;
    this.sessionDate = sessionDate;
    this.lastActivityAt = startedAt;
  }

  addEntry(entry: SessionEvent): void {
    if (entry.type === "session_open") return;
    this.timeline.push(entry);
    this.lastActivityAt = entry.ts;
  }

  getConversationTurns(limit?: number): ConversationTurn[] {
    const turns = flattenExchanges(this.getConversationExchanges(), this.sessionPath);
    return typeof limit === "number" && limit > 0 ? turns.slice(-limit) : turns;
  }

  getConversationExchanges(limit?: number): ConversationExchange[] {
    const exchanges: ConversationExchange[] = [];
    for (const entry of this.timeline) {
      if (entry.type === "user_message") {
        exchanges.push({
          runId: entry.runId,
          user: {
            timestamp: entry.ts,
            content: entry.content,
          },
        });
        continue;
      }

      if (entry.type === "assistant_response") {
        const exchange = exchanges.find((item) => item.runId === entry.runId);
        if (exchange) {
          exchange.assistant = {
            timestamp: entry.ts,
            content: entry.content,
            responseKind: entry.responseKind,
          };
        }
      }
    }

    return typeof limit === "number" && limit > 0 ? exchanges.slice(-limit) : exchanges;
  }

  getRecentSystemActivity(limit = 5): SystemActivityItem[] {
    const activity = this.timeline
      .filter((entry): entry is SystemEventEntry => entry.type === "system_event")
      .map((entry) => ({
        timestamp: entry.ts,
        source: entry.source,
        event: entry.event,
        eventId: entry.eventId,
        summary: entry.summary,
        responseKind: "notification" as const,
        userVisible: true,
      }));
    return limit > 0 ? activity.slice(-limit) : activity;
  }
}

function flattenExchanges(exchanges: ConversationExchange[], sessionPath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const exchange of exchanges) {
    turns.push({
      role: "user",
      content: exchange.user.content,
      timestamp: exchange.user.timestamp,
      sessionPath,
      runId: exchange.runId,
    });
    if (exchange.assistant) {
      turns.push({
        role: "assistant",
        content: exchange.assistant.content,
        timestamp: exchange.assistant.timestamp,
        sessionPath,
        runId: exchange.runId,
        assistantResponseKind: exchange.assistant.responseKind,
      });
    }
  }
  return turns;
}
