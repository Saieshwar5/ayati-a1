import type {
  ActiveAttachmentsEvent,
  AssistantNotificationEvent,
  AssistantFeedbackEvent,
  FeedbackOpenedEvent,
  FeedbackResolvedEvent,
  CountableSessionEvent,
  ToolSessionEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  TurnStatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  AgentStepEvent,
  RunLedgerEvent,
  TaskSummaryEvent,
  SystemEventReceivedEvent,
  SystemEventProcessedEvent,
} from "./session-events.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type {
  ActiveAttachmentRecord,
  ActiveAttachmentRef,
  AgentStepMemoryEvent,
  ConversationTurn,
  SessionHandoffArtifact,
  SessionHandoffPhase,
  SessionRotationReason,
  SystemActivityItem,
  ToolMemoryEvent,
} from "./types.js";

export type SessionTimelineEntry =
  | UserMessageEvent
  | AssistantMessageEvent
  | TurnStatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | RunLedgerEvent
  | ActiveAttachmentsEvent
  | TaskSummaryEvent
  | AssistantFeedbackEvent
  | AssistantNotificationEvent
  | FeedbackOpenedEvent
  | FeedbackResolvedEvent
  | SystemEventReceivedEvent
  | SystemEventProcessedEvent;

const COUNTABLE_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "assistant_feedback",
]);

interface SessionHandoffRuntimeState {
  phase: SessionHandoffPhase;
  requestedRevision: number;
  preparedRevision: number;
  preparedAt: string | null;
  artifact: SessionHandoffArtifact | null;
  jobScheduled: boolean;
}

export class InMemorySession {
  readonly id: string;
  readonly clientId: string;
  readonly startedAt: string;
  readonly sessionPath: string;
  readonly parentSessionId: string | null;
  lastActivityAt: string;
  timeline: SessionTimelineEntry[];
  userTurnCount: number;
  assistantTurnCount: number;
  handoffSummary: string | null = null;
  pendingRotationReason: SessionRotationReason | null = null;
  handoff: SessionHandoffRuntimeState;

  constructor(
    id: string,
    clientId: string,
    startedAt: string,
    sessionPath: string,
    parentSessionId?: string | null,
  ) {
    this.id = id;
    this.clientId = clientId;
    this.startedAt = startedAt;
    this.sessionPath = sessionPath;
    this.parentSessionId = parentSessionId ?? null;
    this.lastActivityAt = startedAt;
    this.timeline = [];
    this.userTurnCount = 0;
    this.assistantTurnCount = 0;
    this.handoff = {
      phase: "inactive",
      requestedRevision: 0,
      preparedRevision: 0,
      preparedAt: null,
      artifact: null,
      jobScheduled: false,
    };
  }

  addEntry(entry: SessionTimelineEntry): void {
    this.timeline.push(entry);
    this.lastActivityAt = entry.ts;

    if (entry.type === "user_message") {
      this.userTurnCount++;
    } else if (entry.type === "assistant_message" || entry.type === "assistant_feedback") {
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
      } else if (entry.type === "assistant_message" || entry.type === "assistant_feedback") {
        turns.push({
          role: "assistant",
          content: entry.type === "assistant_message" ? entry.content : entry.message,
          timestamp: entry.ts,
          sessionPath: entry.sessionPath,
          assistantResponseKind: entry.type === "assistant_message"
            ? (entry.responseKind ?? "reply")
            : "feedback",
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

  getRecentSystemActivity(limit = 10): SystemActivityItem[] {
    if (limit <= 0) return [];

    const activity: SystemActivityItem[] = [];
    for (const entry of this.timeline) {
      if (entry.type === "assistant_notification") {
        activity.push({
          timestamp: entry.ts,
          source: entry.source ?? "assistant",
          event: entry.event ?? "notification",
          eventId: entry.eventId ?? `notification:${entry.ts}`,
          summary: entry.message,
          userVisible: true,
          responseKind: "notification",
        });
        continue;
      }

      if (entry.type === "system_event_processed") {
        activity.push({
          timestamp: entry.ts,
          source: entry.source,
          event: entry.event,
          eventId: entry.eventId,
          summary: entry.summary?.trim() || `${entry.source}/${entry.event}`,
          note: entry.note,
          responseKind: entry.responseKind,
          userVisible: entry.responseKind !== "none",
        });
      }
    }

    return activity.slice(-limit);
  }

  getRecentUniqueRunLedgerEvents(limit = 5): RunLedgerEvent[] {
    if (limit <= 0) return [];

    const uniqueRunIds = new Set<string>();
    const events: RunLedgerEvent[] = [];

    for (let idx = this.timeline.length - 1; idx >= 0; idx--) {
      const entry = this.timeline[idx];
      if (!entry || entry.type !== "run_ledger") continue;
      if (uniqueRunIds.has(entry.runId)) continue;

      uniqueRunIds.add(entry.runId);
      events.push(entry);
      if (events.length >= limit) break;
    }

    return events;
  }

  getRecentTaskSummaryEvents(limit = 5): TaskSummaryEvent[] {
    if (limit <= 0) return [];

    const events: TaskSummaryEvent[] = [];
    for (let idx = this.timeline.length - 1; idx >= 0; idx--) {
      const entry = this.timeline[idx];
      if (!entry || entry.type !== "task_summary") continue;
      events.push(entry);
      if (events.length >= limit) break;
    }

    return events;
  }

  getActiveAttachmentRecords(limit = 5): ActiveAttachmentRecord[] {
    if (limit <= 0) return [];

    const seen = new Set<string>();
    const records: ActiveAttachmentRecord[] = [];

    for (let idx = this.timeline.length - 1; idx >= 0; idx--) {
      const entry = this.timeline[idx];
      if (!entry || entry.type !== "active_attachments") continue;
      for (const attachment of entry.attachments) {
        const documentId = attachment.summary.documentId;
        if (!documentId || seen.has(documentId)) {
          continue;
        }
        seen.add(documentId);
        records.push({
          documentId,
          displayName: attachment.summary.displayName,
          kind: attachment.summary.kind,
          mode: attachment.summary.mode,
          runId: entry.runId,
          runPath: entry.runPath,
          preparedInputId: attachment.summary.preparedInputId,
          lastUsedAt: entry.ts,
          lastAction: entry.action,
          manifest: attachment.manifest,
          summary: attachment.summary,
          detail: attachment.detail ?? {},
        });
        if (records.length >= limit) {
          return records;
        }
      }
    }

    return records;
  }

  getActiveAttachmentRefs(limit = 5): ActiveAttachmentRef[] {
    return this.getActiveAttachmentRecords(limit).map((record) => ({
      documentId: record.documentId,
      displayName: record.displayName,
      kind: record.kind,
      mode: record.mode,
      runId: record.runId,
      runPath: record.runPath,
      preparedInputId: record.preparedInputId,
      lastUsedAt: record.lastUsedAt,
      lastAction: record.lastAction,
    }));
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
