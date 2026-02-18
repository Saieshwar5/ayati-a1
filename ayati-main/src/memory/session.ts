import type {
  CountableSessionEvent,
  ToolSessionEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  TurnStatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  AgentStepEvent,
  AssistantFeedbackEvent,
} from "./session-events.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { AgentStepMemoryEvent, ConversationTurn, ToolMemoryEvent } from "./types.js";

export type SessionTimelineEntry =
  | UserMessageEvent
  | AssistantMessageEvent
  | TurnStatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | AssistantFeedbackEvent;

const COUNTABLE_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
]);

export class InMemorySession {
  readonly id: string;
  readonly clientId: string;
  readonly startedAt: string;
  readonly sessionPath: string;
  lastActivityAt: string;
  timeline: SessionTimelineEntry[];
  userTurnCount: number;
  assistantTurnCount: number;

  constructor(id: string, clientId: string, startedAt: string, sessionPath: string) {
    this.id = id;
    this.clientId = clientId;
    this.startedAt = startedAt;
    this.sessionPath = sessionPath;
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

  getConversationTurns(limit?: number): ConversationTurn[] {
    const entries = this.getCountableEntries(limit);
    const turns: ConversationTurn[] = [];

    for (const entry of entries) {
      if (entry.type === "user_message") {
        turns.push({
          role: "user",
          content: entry.content,
          timestamp: entry.ts,
          sessionPath: entry.sessionPath,
        });
      } else if (entry.type === "assistant_message") {
        turns.push({
          role: "assistant",
          content: entry.content,
          timestamp: entry.ts,
          sessionPath: entry.sessionPath,
        });
      }
    }

    return turns;
  }

  getCountableEvents(limit?: number): CountableSessionEvent[] {
    return this.getCountableEntries(limit) as CountableSessionEvent[];
  }

  getToolEvents(limit?: number): ToolMemoryEvent[] {
    const entries = this.getToolEntries(limit);
    const events: ToolMemoryEvent[] = [];

    for (const entry of entries) {
      if (entry.type === "tool_call") {
        events.push({
          timestamp: entry.ts,
          sessionPath: entry.sessionPath,
          toolName: entry.toolName,
          eventType: "tool_call",
          args: JSON.stringify(entry.args ?? {}),
          output: "",
        });
      } else if (entry.type === "tool_result") {
        events.push({
          timestamp: entry.ts,
          sessionPath: entry.sessionPath,
          toolName: entry.toolName,
          eventType: "tool_result",
          args: this.findToolCallArgs(entry.toolCallId),
          status: entry.status,
          output: entry.output ?? "",
          errorMessage: entry.errorMessage,
        });
      }
    }

    return events;
  }

  getToolSessionEvents(limit?: number): ToolSessionEvent[] {
    return this.getToolEntries(limit) as ToolSessionEvent[];
  }

  getAgentStepEvents(limit?: number): AgentStepMemoryEvent[] {
    const entries = this.getAgentStepEntries(limit);
    return entries.map((entry) => ({
      timestamp: entry.ts,
      sessionPath: entry.sessionPath,
      step: entry.step,
      phase: entry.phase,
      summary: entry.summary,
      actionToolName: entry.actionToolName,
      endStatus: entry.endStatus,
    }));
  }

  getAgentStepSessionEvents(limit?: number): AgentStepEvent[] {
    return this.getAgentStepEntries(limit);
  }

  findToolCallArgs(toolCallId: string): string {
    for (const entry of this.timeline) {
      if (entry.type === "tool_call" && entry.toolCallId === toolCallId) {
        return JSON.stringify(entry.args ?? {});
      }
    }
    return "{}";
  }

  estimateToolEventTokens(limit?: number): number {
    let total = 0;
    for (const event of this.getToolEvents(limit)) {
      total += estimateTextTokens(event.args);
      total += estimateTextTokens(event.output);
      if (event.errorMessage) {
        total += estimateTextTokens(event.errorMessage);
      }
    }
    return total;
  }

  getCountableEventCount(): number {
    let count = 0;
    for (const entry of this.timeline) {
      if (COUNTABLE_EVENT_TYPES.has(entry.type)) {
        count++;
      }
    }
    return count;
  }

  getExchangeCount(): number {
    return Math.min(this.userTurnCount, this.assistantTurnCount);
  }

  private getCountableEntries(limit?: number): SessionTimelineEntry[] {
    const entries = this.timeline.filter((entry) => COUNTABLE_EVENT_TYPES.has(entry.type));
    if (limit === undefined || limit <= 0) return entries;
    return entries.slice(-limit);
  }

  private getToolEntries(limit?: number): SessionTimelineEntry[] {
    const entries = this.timeline.filter((entry) => entry.type === "tool_call" || entry.type === "tool_result");
    if (limit === undefined || limit <= 0) return entries;
    return entries.slice(-limit);
  }

  private getAgentStepEntries(limit?: number): AgentStepEvent[] {
    const entries = this.timeline.filter((entry): entry is AgentStepEvent => entry.type === "agent_step");
    if (limit === undefined || limit <= 0) return entries;
    return entries.slice(-limit);
  }
}
