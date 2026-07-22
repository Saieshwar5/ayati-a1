import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { LoopState } from "../types.js";
import { harnessContextFromState } from "../harness-context.js";
import type { AgentTemporalEvent, AgentTemporalExactEvent } from "./agent-context-events.js";

export type { AgentTemporalEvent, AgentTemporalExactEvent } from "./agent-context-events.js";

const LIMITS = {
  memoryChars: 1_200,
};

export interface AgentContextPack {
  temporal: {
    checkpoint?: ContextEngineMachineContext["agentStream"]["checkpoint"] extends infer Value
      ? Value
      : never;
    recent: AgentTemporalEvent[];
  };
  current: {
    inputSeq: number;
    runId: string;
    routing?: {
      status: "unbound" | "bound" | "clarifying";
      workstreamId?: string;
      requestId?: string;
    };
  };
  stream: {
    agentId: string;
    scopeKey: string;
    recentWork: ContextEngineMachineContext["agentStream"]["recentWork"];
  };
  work: {
    candidates: NonNullable<ContextEngineMachineContext["workstreamCandidates"]>;
    active?: ContextEngineMachineContext["workstream"];
  };
  resources: {
    stream: ContextEngineMachineContext["agentStream"]["resources"];
    ingress: NonNullable<ContextEngineMachineContext["ingressResources"]>;
    activeWorkstream: NonNullable<ContextEngineMachineContext["workstream"]>["resources"];
  };
  observations: ContextEngineMachineContext["observations"];
  personalMemorySnapshot?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  const harnessContext = harnessContextFromState(state);
  const context = harnessContext.contextEngine;
  const recent = buildTimeline(state, context);
  const currentInput = recent.find((event) => "current" in event && event.current === true);
  return {
    temporal: {
      ...(context?.agentStream.checkpoint ? { checkpoint: context.agentStream.checkpoint } : {}),
      recent,
    },
    current: {
      inputSeq: currentInput?.seq ?? state.currentSeq,
      runId: state.runId,
      ...(context?.current.routing ? {
        routing: {
          status: context.current.routing.status,
          ...(context.current.routing.workstreamId
            ? { workstreamId: context.current.routing.workstreamId }
            : {}),
          ...(context.current.routing.requestId
            ? { requestId: context.current.routing.requestId }
            : {}),
        },
      } : {}),
    },
    stream: {
      agentId: context?.agentStream.meta.agentId ?? "local",
      scopeKey: context?.agentStream.meta.scopeKey ?? "default",
      recentWork: context?.agentStream.recentWork ?? [],
    },
    work: {
      candidates: context?.workstreamCandidates ?? [],
      ...(context?.workstream ? { active: context.workstream } : {}),
    },
    resources: {
      stream: context?.agentStream.resources ?? [],
      ingress: context?.ingressResources ?? [],
      activeWorkstream: context?.workstream?.resources ?? [],
    },
    observations: context?.observations ?? {
      revision: "observations:empty",
      inventory: [],
      discovery: [],
      evidence: [],
    },
    ...(harnessContext.personalMemorySnapshot.trim()
      ? { personalMemorySnapshot: truncate(harnessContext.personalMemorySnapshot, LIMITS.memoryChars) }
      : {}),
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
    const current = index === currentRecordIndex;
    if (message.role === "assistant") {
      return {
        kind: "assistant",
        seq: message.sequence,
        timestamp: message.at,
        content: message.content,
        ...(assistantExpectsUserResponse(message.content) ? { expectsUserResponse: true } : {}),
        ...(current ? { current: true } : {}),
      };
    }
    if (message.role === "system_event") {
      return {
        kind: "system",
        seq: message.sequence,
        timestamp: message.at,
        content: message.content,
        ...(current ? { current: true } : {}),
      };
    }
    return {
      kind: "user",
      seq: message.sequence,
      timestamp: message.at,
      content: message.content,
      ...(current ? { current: true } : {}),
    };
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

function assistantExpectsUserResponse(content: string): boolean {
  const normalized = normalizeText(content);
  return normalized.endsWith("?") || normalized.includes("which one");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
