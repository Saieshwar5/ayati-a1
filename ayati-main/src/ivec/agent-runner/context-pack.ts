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
  const records = gitContext?.session.conversationTail ?? [];
  const currentRecordIndex = findCurrentConversationRecordIndex(state, records);
  if (state.currentMessageId && currentRecordIndex < 0) {
    throw new Error(
      `CURRENT_INPUT_CONTEXT_MISMATCH: message ${state.currentMessageId} is not present in the prepared conversation context.`,
    );
  }
  const fromGit = records
    .map((record, index): ExactTimelineEvent => {
      const current = index === currentRecordIndex;
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

  const timeline = orderTimeline(ensureCurrentEvent(state, fromGit));
  verifyCurrentUserInput(state, timeline);
  return timeline;
}

function findCurrentConversationRecordIndex(
  state: LoopState,
  records: ContextEngineMachineContext["session"]["conversationTail"],
): number {
  if (state.currentMessageId) {
    return records.findIndex((record) => record.messageId === state.currentMessageId);
  }
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record?.role === "user" && normalizeText(record.text) === normalizeText(state.userMessage)) {
      return index;
    }
  }
  return -1;
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

function verifyCurrentUserInput(state: LoopState, timeline: ExactTimelineEvent[]): void {
  if (state.inputKind !== "user_message") return;
  const current = timeline.filter((event) => event.current === true);
  const event = current[0];
  const content = event && "content" in event ? event.content : undefined;
  if (current.length !== 1 || event?.kind !== "user" || normalizeText(content ?? "") !== normalizeText(state.userMessage)) {
    throw new Error(
      "CURRENT_INPUT_CONTEXT_MISMATCH: the projected timeline does not contain exactly one current user message matching the incoming request.",
    );
  }
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
