import type { LoopState } from "../types.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { harnessContextFromState } from "../harness-context.js";

const LIMITS = {
  timelineEvents: 12,
  textChars: 500,
  memoryChars: 1_200,
};

export type TimelineEvent =
  | {
      kind: "user";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "assistant";
      seq: number;
      timestamp: string;
      content: string;
      responseKind?: string;
      expectsUserResponse?: boolean;
      current?: true;
    }
  | {
      kind: "system";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "system_event";
      seq: number;
      timestamp: string;
      source: string;
      event: string;
      summary: string;
      current?: true;
    };

export interface AgentContextPack {
  timeline: TimelineEvent[];
  gitContext?: ContextEngineMachineContext;
  personalMemorySnapshot?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  const harnessContext = harnessContextFromState(state);
  const gitContext = harnessContext.contextEngine;
  return {
    timeline: buildTimeline(state, gitContext),
    ...(gitContext ? { gitContext } : {}),
    ...(harnessContext.personalMemorySnapshot.trim()
      ? { personalMemorySnapshot: truncate(harnessContext.personalMemorySnapshot, LIMITS.memoryChars) }
      : {}),
  };
}

function buildTimeline(
  state: LoopState,
  gitContext: ContextEngineMachineContext | undefined,
): TimelineEvent[] {
  const fromGit = (gitContext?.session.conversationTail ?? [])
    .map((record): TimelineEvent => {
      const current = isCurrentConversationRecord(state, record.seq, record.role, record.text);
      if (record.role === "assistant") {
        return {
          kind: "assistant",
	          seq: record.seq,
	          timestamp: record.at,
	          content: truncate(record.text, LIMITS.textChars),
	          ...(record.kind === "feedback_question" ? { responseKind: "feedback", expectsUserResponse: true } : {}),
	          ...(assistantExpectsUserResponse(record.text) ? { expectsUserResponse: true } : {}),
	          ...(current ? { current: true } : {}),
        };
      }
      if (record.role === "system") {
        return {
          kind: "system",
          seq: record.seq,
          timestamp: record.at,
          content: truncate(record.text, LIMITS.textChars),
          ...(current ? { current: true } : {}),
        };
      }
      return {
        kind: "user",
        seq: record.seq,
        timestamp: record.at,
        content: truncate(record.text, LIMITS.textChars),
        ...(current ? { current: true } : {}),
      };
    });

  return preserveQuestionWhenTrimming(ensureCurrentEvent(state, fromGit), LIMITS.timelineEvents);
}

function isCurrentConversationRecord(
  state: LoopState,
  seq: number,
  role: string,
  text: string,
): boolean {
  if (state.currentSeq > 0 && seq === state.currentSeq && role === "user") {
    return true;
  }
  if (role !== "user") {
    return false;
  }
  return normalizeText(text) === normalizeText(state.userMessage);
}

function ensureCurrentEvent(state: LoopState, events: TimelineEvent[]): TimelineEvent[] {
  if (events.some((event) => event.current)) {
    return events;
  }
  const seq = Math.max(1, ...events.map((event) => event.seq), state.currentSeq || 1);
  if (state.inputKind === "system_event" && state.systemEvent) {
    return [
      ...events,
      {
        kind: "system_event",
        seq,
        timestamp: new Date(0).toISOString(),
        source: state.systemEvent.source,
        event: state.systemEvent.eventName,
        summary: truncate(state.systemEvent.summary, LIMITS.textChars),
        current: true,
      },
    ];
  }
  return [
    ...events,
    {
      kind: "user",
      seq,
      timestamp: new Date(0).toISOString(),
      content: truncate(state.userMessage, LIMITS.textChars),
      current: true,
    },
  ];
}

function preserveQuestionWhenTrimming(events: TimelineEvent[], limit: number): TimelineEvent[] {
  if (events.length <= limit) {
    return orderTimeline(events);
  }
  const current = events.find((event) => event.current);
  const latestQuestion = [...events].reverse().find((event) => event.kind === "assistant" && event.expectsUserResponse);
  const tail = events.slice(-limit);
  for (const required of [latestQuestion, current]) {
    if (!required || tail.some((event) => sameTimelineEvent(event, required))) {
      continue;
    }
    const replaceIndex = tail.findIndex((event) => !event.current && !(event.kind === "assistant" && event.expectsUserResponse));
    if (replaceIndex >= 0) {
      tail[replaceIndex] = required;
    }
  }
  return orderTimeline(tail);
}

function orderTimeline(events: TimelineEvent[]): TimelineEvent[] {
  const currentEvent = events.find((event) => event.current);
  return [
    ...events.filter((event) => !event.current).sort((a, b) => a.seq - b.seq),
    ...(currentEvent ? [currentEvent] : []),
  ];
}

function sameTimelineEvent(left: TimelineEvent, right: TimelineEvent): boolean {
  return left.seq === right.seq && left.kind === right.kind;
}

function assistantExpectsUserResponse(content: string): boolean {
  const normalized = normalizeText(content);
  return normalized.endsWith("?") || normalized.includes("which one");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
