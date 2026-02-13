import type {
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
} from "./session-events.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ConversationTurn, ToolMemoryEvent } from "./types.js";

export type SessionTimelineEntry =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent;

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
  timeline: SessionTimelineEntry[];
  userTurnCount: number;
  assistantTurnCount: number;

  constructor(id: string, clientId: string, startedAt: string) {
    this.id = id;
    this.clientId = clientId;
    this.startedAt = startedAt;
    this.lastActivityAt = startedAt;
    this.timeline = [];
    this.userTurnCount = 0;
    this.assistantTurnCount = 0;
  }

  addEntry(entry: SessionTimelineEntry): void {
    this.timeline.push(entry);
    this.lastActivityAt = entry.ts;

    if (entry.type === "user_message") {
      this.userTurnCount++;
    } else if (entry.type === "assistant_message") {
      this.assistantTurnCount++;
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

  estimateToolEventTokens(): number {
    let total = 0;
    for (const entry of this.timeline) {
      if (entry.type === "tool_result") {
        const argsText = truncate(this.findToolCallArgs(entry.toolCallId), MAX_ARGS_PREVIEW_CHARS);
        const outputText = truncate(entry.output || entry.errorMessage || "", MAX_OUTPUT_PREVIEW_CHARS);
        total += estimateTextTokens(argsText) + estimateTextTokens(outputText);
      }
    }
    return total;
  }

  getExchangeCount(): number {
    return Math.min(this.userTurnCount, this.assistantTurnCount);
  }
}
