import type {
  SessionEvent,
  SessionTier,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  SessionTierChangeEvent,
} from "./session-events.js";
import type { ConversationTurn, ToolMemoryEvent } from "./types.js";
import type { TierState } from "./tiering.js";
import { createInitialTierState } from "./tiering.js";

export type SessionTimelineEntry =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | SessionTierChangeEvent;

function estimateTokens(text: string): number {
  const chars = text.trim().length;
  if (chars === 0) return 1;
  return Math.max(1, Math.ceil(chars / 4));
}

const MAX_ARGS_PREVIEW_CHARS = 200;
const MAX_OUTPUT_PREVIEW_CHARS = 700;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)} ...[truncated]`;
}

export class InMemorySession {
  readonly id: string;
  readonly clientId: string;
  readonly startedAt: string;
  lastActivityAt: string;
  tierState: TierState;
  timeline: SessionTimelineEntry[];
  userTurnCount: number;

  constructor(
    id: string,
    clientId: string,
    startedAt: string,
    tier: SessionTier,
  ) {
    this.id = id;
    this.clientId = clientId;
    this.startedAt = startedAt;
    this.lastActivityAt = startedAt;
    this.tierState = createInitialTierState(tier);
    this.timeline = [];
    this.userTurnCount = 0;
  }

  addEntry(entry: SessionTimelineEntry): void {
    this.timeline.push(entry);
    this.lastActivityAt = entry.ts;

    if (entry.type === "user_message") {
      this.userTurnCount++;
    }
  }

  getConversationTurns(): ConversationTurn[] {
    const turns: ConversationTurn[] = [];

    for (const entry of this.timeline) {
      if (entry.type === "user_message") {
        turns.push({ role: "user", content: entry.content, timestamp: entry.ts });
      } else if (entry.type === "assistant_message") {
        turns.push({ role: "assistant", content: entry.content, timestamp: entry.ts });
      }
    }

    return turns;
  }

  getToolEvents(): ToolMemoryEvent[] {
    const events: ToolMemoryEvent[] = [];

    for (const entry of this.timeline) {
      if (entry.type === "tool_result") {
        events.push({
          timestamp: entry.ts,
          toolName: entry.toolName,
          status: entry.status,
          argsPreview: truncate(this.findToolCallArgs(entry.toolCallId), MAX_ARGS_PREVIEW_CHARS),
          outputPreview: truncate(entry.output || entry.errorMessage || "", MAX_OUTPUT_PREVIEW_CHARS),
          errorMessage: entry.errorMessage,
        });
      }
    }

    return events;
  }

  getTimelineForScoring(): Array<{ type: string; ts: string; tokenEstimate?: number }> {
    return this.timeline.map((entry) => {
      let tokenEstimate: number | undefined;
      if (entry.type === "user_message" || entry.type === "assistant_message") {
        tokenEstimate = estimateTokens(entry.content);
      }
      return { type: entry.type, ts: entry.ts, tokenEstimate };
    });
  }

  findToolCallArgs(toolCallId: string): string {
    for (const entry of this.timeline) {
      if (entry.type === "tool_call" && entry.toolCallId === toolCallId) {
        return JSON.stringify(entry.args ?? {});
      }
    }
    return "{}";
  }

  findToolCallRawArgs(toolCallId: string): unknown {
    for (const entry of this.timeline) {
      if (entry.type === "tool_call" && entry.toolCallId === toolCallId) {
        return entry.args;
      }
    }
    return {};
  }
}
