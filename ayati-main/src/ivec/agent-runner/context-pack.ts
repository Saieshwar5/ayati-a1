import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LoopState } from "../types.js";
import { harnessContextFromState } from "../harness-context.js";
import { activeDocumentPointers } from "../recent-document-registry.js";
import {
  projectStreamMessageEvent,
  type AgentTemporalEvent,
  type AgentTemporalExactEvent,
} from "./agent-context-events.js";
import { buildCoreCapsule, type CoreCapsule } from "./core-capsule.js";
import { buildFocusedWorkstreamPromptContext } from "./focused-workstream-prompt-context.js";

export type { AgentTemporalEvent, AgentTemporalExactEvent } from "./agent-context-events.js";
export type { CoreCapsule } from "./core-capsule.js";

export interface AgentContextPack {
  core: CoreCapsule;
  hot: LoopState["hotContext"];
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  const harnessContext = harnessContextFromState(state);
  const context = harnessContext.contextEngine;
  const recent = buildTimeline(state, context);
  const currentInput = recent.find((event) => "current" in event && event.current === true);
  return {
    core: buildCoreCapsule({
      revision: context?.contextRevision ?? `core:${state.runId}:${currentInput?.seq ?? state.currentSeq}`,
      runId: state.runId,
      timeline: recent,
      ...(context?.agentStream.checkpoint ? { checkpoint: context.agentStream.checkpoint } : {}),
      ...(context?.current.routing ? { routing: context.current.routing } : {}),
      focusedWorkstream: buildFocusedWorkstreamPromptContext(
        context?.agentStream.focusedWorkstream,
      ),
      activeDocuments: activeDocumentPointers(
        context?.agentStream.recentFiles ?? [],
      ),
    }),
    hot: state.hotContext,
  };
}

function buildTimeline(
  state: LoopState,
  context: ContextEngineMachineContext | undefined,
): AgentTemporalEvent[] {
  const messages = context?.agentStream.recentMessages ?? [];
  const currentRecordIndex = findCurrentMessageIndex(state, messages);
  if (state.currentMessageId && currentRecordIndex < 0) {
    throw new Error(
      `CURRENT_INPUT_CONTEXT_MISMATCH: message ${state.currentMessageId} is not present in the prepared agent-stream context.`,
    );
  }
  const fromStream = messages.map((message, index): AgentTemporalExactEvent => {
    return projectStreamMessageEvent(message, index === currentRecordIndex);
  });

  const timeline = orderTimeline(ensureCurrentEvent(state, fromStream));
  verifyCurrentUserInput(state, timeline);
  return timeline;
}

function findCurrentMessageIndex(
  state: LoopState,
  messages: ContextEngineMachineContext["agentStream"]["recentMessages"],
): number {
  if (state.currentMessageId) {
    return messages.findIndex((message) => message.messageId === state.currentMessageId);
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && normalizeText(message.content) === normalizeText(state.userMessage)) {
      return index;
    }
  }
  return -1;
}

function ensureCurrentEvent(state: LoopState, events: AgentTemporalExactEvent[]): AgentTemporalExactEvent[] {
  if (events.some((event) => event.current)) return events;
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

function orderTimeline(events: AgentTemporalExactEvent[]): AgentTemporalExactEvent[] {
  const currentEvent = events.find((event) => event.current);
  return [
    ...events.filter((event) => !event.current).sort((a, b) => a.seq - b.seq),
    ...(currentEvent ? [currentEvent] : []),
  ];
}

function verifyCurrentUserInput(state: LoopState, timeline: AgentTemporalExactEvent[]): void {
  if (state.inputKind !== "user_message") return;
  const current = timeline.filter((event) => event.current === true);
  const event = current[0];
  const content = event && "content" in event ? event.content : undefined;
  if (current.length !== 1
    || event?.kind !== "user"
    || normalizeText(content ?? "") !== normalizeText(state.userMessage)) {
    throw new Error(
      "CURRENT_INPUT_CONTEXT_MISMATCH: the projected temporal lane does not contain exactly one current user message matching the incoming request.",
    );
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
