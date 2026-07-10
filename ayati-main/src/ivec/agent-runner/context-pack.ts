import type { LoopState } from "../types.js";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { harnessContextFromState } from "../harness-context.js";
import type { ExactTimelineEvent, TimelineEvent } from "./timeline-checkpoint.js";

export type { ExactTimelineEvent, TimelineEvent } from "./timeline-checkpoint.js";

const LIMITS = {
  memoryChars: 1_200,
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
    .map((record): ExactTimelineEvent => {
      const current = isCurrentConversationRecord(state, record.seq, record.role, record.text);
      if (record.role === "assistant") {
        return {
          kind: "assistant",
          seq: record.seq,
          timestamp: record.at,
          content: record.text,
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
          content: record.text,
          ...(current ? { current: true } : {}),
        };
      }
      return {
        kind: "user",
        seq: record.seq,
        timestamp: record.at,
        content: record.text,
        ...(current ? { current: true } : {}),
      };
    });

  return orderTimeline(ensureCurrentEvent(state, fromGit));
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

function ensureCurrentEvent(state: LoopState, events: ExactTimelineEvent[]): ExactTimelineEvent[] {
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
        summary: state.systemEvent.summary,
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
      content: state.userMessage,
      current: true,
    },
  ];
}

function orderTimeline(events: ExactTimelineEvent[]): ExactTimelineEvent[] {
  const currentEvent = events.find((event) => event.current);
  return [
    ...events.filter((event) => !event.current).sort((a, b) => a.seq - b.seq),
    ...(currentEvent ? [currentEvent] : []),
  ];
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
