import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devWarn } from "../shared/index.js";
import type {
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  TurnStatusRecordInput,
  CreateSessionInput,
  CreateSessionResult,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  RunLedgerRecordInput,
  TaskSummaryRecordInput,
  SystemEventRecordInput,
  SystemEventOutcomeRecordInput,
  PromptMemoryContext,
  ConversationTurn,
} from "./types.js";
import type {
  SessionEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  TurnStatusEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  AgentStepEvent,
  RunLedgerEvent,
  TaskSummaryEvent,
  AssistantFeedbackEvent,
  SystemEventReceivedEvent,
  SystemEventProcessedEvent,
} from "./session-events.js";
import { InMemorySession } from "./session.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";

const MIN_TURNS_FOR_CALLBACK = 2;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 100_000;

export interface SessionCloseData {
  sessionId: string;
  clientId: string;
  turns: ConversationTurn[];
  reason: string;
}

export interface TaskSummaryIndexData {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  runId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  summary: string;
  timestamp: string;
}

export interface HandoffSummaryIndexData {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  summary: string;
  timestamp: string;
}

export interface MemoryManagerOptions extends SessionPersistenceOptions {
  now?: () => Date;
  onSessionClose?: (data: SessionCloseData) => void | Promise<void>;
  onTaskSummaryIndexed?: (data: TaskSummaryIndexData) => void | Promise<void>;
  onHandoffSummaryIndexed?: (data: HandoffSummaryIndexData) => void | Promise<void>;
  contextTokenLimit?: number;
  memoryDetailMode?: "compact" | "debug";
}

type TimelineEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | TurnStatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | RunLedgerEvent
  | TaskSummaryEvent
  | AssistantFeedbackEvent
  | SystemEventReceivedEvent
  | SystemEventProcessedEvent;

export class MemoryManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly nowProvider: () => Date;
  private readonly onSessionCloseCallback?: (data: SessionCloseData) => void | Promise<void>;
  private readonly onTaskSummaryIndexedCallback?: (data: TaskSummaryIndexData) => void | Promise<void>;
  private readonly onHandoffSummaryIndexedCallback?: (data: HandoffSummaryIndexData) => void | Promise<void>;
  private readonly contextTokenLimit: number;
  private readonly memoryDetailMode: "compact" | "debug";

  private currentSession: InMemorySession | null = null;
  private staticTokenBudget = 0;
  private activeClientId = "";
  private backgroundQueue: Promise<void> = Promise.resolve();

  constructor(options?: MemoryManagerOptions) {
    this.persistence = new SessionPersistence({
      dbPath: options?.dbPath,
      dataDir: options?.dataDir,
    });
    this.nowProvider = options?.now ?? (() => new Date());
    this.onSessionCloseCallback = options?.onSessionClose;
    this.onTaskSummaryIndexedCallback = options?.onTaskSummaryIndexed;
    this.onHandoffSummaryIndexedCallback = options?.onHandoffSummaryIndexed;
    this.contextTokenLimit = options?.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
    this.memoryDetailMode = options?.memoryDetailMode ?? "compact";
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.restoreActiveSession(clientId);
  }

  async shutdown(): Promise<void> {
    if (this.currentSession) {
      // Keep the current session active across graceful restart.
      this.persistence.writeActiveSessionMarker(
        this.currentSession.id,
        this.currentSession.sessionPath,
      );
    }

    try {
      await this.backgroundQueue;
    } catch (err) {
      devWarn("Background memory task failed during shutdown:", err instanceof Error ? err.message : String(err));
    }

    this.persistence.stop();
    this.currentSession = null;
  }

  beginRun(clientId: string, userMessage: string): MemoryRunHandle {
    const nowIso = this.nowIso();
    this.ensureOpenSession(clientId, nowIso);

    const session = this.currentSession!;
    const runId = randomUUID();

    const event: UserMessageEvent = {
      v: 2,
      ts: nowIso,
      type: "user_message",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      content: userMessage,
    };

    this.appendTimelineEvent(event);

    return { sessionId: session.id, runId };
  }

  beginSystemRun(clientId: string, input: SystemEventRecordInput): MemoryRunHandle {
    const nowIso = this.nowIso();
    this.ensureOpenSession(clientId, nowIso);

    const session = this.currentSession!;
    const runId = randomUUID();

    const event: SystemEventReceivedEvent = {
      v: 2,
      ts: nowIso,
      type: "system_event_received",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId,
      source: input.source,
      event: input.event,
      eventId: input.eventId,
      occurrenceId: input.occurrenceId,
      reminderId: input.reminderId,
      instruction: input.instruction,
      scheduledFor: input.scheduledFor,
      triggeredAt: input.triggeredAt,
      payload: input.payload,
    };

    this.appendTimelineEvent(event);
    return { sessionId: session.id, runId };
  }

  recordTurnStatus(clientId: string, input: TurnStatusRecordInput): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: TurnStatusEvent = {
      v: 2,
      ts: nowIso,
      type: "turn_status",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      status: input.status,
      note: input.note,
    };

    this.appendTimelineEvent(event);
  }

  createSession(clientId: string, input: CreateSessionInput): CreateSessionResult {
    const nowIso = this.nowIso();
    this.ensureOpenSession(clientId, nowIso);

    const previousSession = this.currentSession!;
    const previousSessionId = previousSession.id;
    const reason = input.reason.trim().length > 0 ? input.reason.trim() : "agent_requested";
    const source = input.source ?? "agent";
    const confidence = input.confidence;
    const handoffSummary = input.handoffSummary?.trim();
    const nextSessionId = randomUUID();
    const nextSessionPath = this.persistence.buildSessionPath(nowIso, nextSessionId);

    if (handoffSummary && this.onHandoffSummaryIndexedCallback) {
      const callback = this.onHandoffSummaryIndexedCallback;
      const callbackData: HandoffSummaryIndexData = {
        clientId,
        sessionId: previousSession.id,
        sessionPath: previousSession.sessionPath,
        summary: handoffSummary,
        timestamp: nowIso,
      };
      this.enqueueBackgroundTask(async () => {
        await callback(callbackData);
      });
    }

    this.closeSessionInternal(previousSession, nowIso, `session_switch:${reason}`, {
      handoffSummary,
      nextSessionId,
      nextSessionPath,
    });
    this.currentSession = null;
    this.createNewSession(clientId, nowIso, {
      sessionId: nextSessionId,
      sessionPath: nextSessionPath,
      parentSessionId: previousSessionId,
      handoffSummary,
    });
    const active = this.currentSession!;

    if (handoffSummary) {
      const handoffEvent: TurnStatusEvent = {
        v: 2,
        ts: nowIso,
        type: "turn_status",
        sessionId: active.id,
        sessionPath: active.sessionPath,
        status: "session_switched",
        note: `handoff_from=${previousSessionId}; handoff_summary=${handoffSummary}`,
      };
      this.appendTimelineEvent(handoffEvent);
    }

    const event: TurnStatusEvent = {
      v: 2,
      ts: nowIso,
      type: "turn_status",
      sessionId: active.id,
      sessionPath: active.sessionPath,
      status: "session_switched",
      note: `source=${source}; reason=${reason}${typeof confidence === "number" ? `; confidence=${confidence}` : ""}`,
    };
    this.appendTimelineEvent(event);

    return {
      previousSessionId,
      sessionId: active.id,
      sessionPath: active.sessionPath,
    };
  }

  recordToolCall(clientId: string, input: ToolCallRecordInput): void {
    if (this.memoryDetailMode !== "debug") {
      return;
    }

    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: ToolCallEvent = {
      v: 2,
      ts: nowIso,
      type: "tool_call",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    };

    this.appendTimelineEvent(event);
  }

  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void {
    if (this.memoryDetailMode !== "debug") {
      return;
    }

    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: ToolResultEvent = {
      v: 2,
      ts: nowIso,
      type: "tool_result",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status,
      output: input.output ?? "",
      errorMessage: input.errorMessage,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
    };

    this.appendTimelineEvent(event);
  }

  recordAssistantFinal(clientId: string, runId: string, _sessionId: string, content: string): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: AssistantMessageEvent = {
      v: 2,
      ts: nowIso,
      type: "assistant_message",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      content,
    };

    this.appendTimelineEvent(event);
  }

  recordRunFailure(clientId: string, runId: string, _sessionId: string, message: string): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: RunFailureEvent = {
      v: 2,
      ts: nowIso,
      type: "run_failure",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      message,
    };

    this.appendTimelineEvent(event);
  }

  recordAgentStep(clientId: string, input: AgentStepRecordInput): void {
    if (this.memoryDetailMode !== "debug") {
      return;
    }

    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: AgentStepEvent = {
      v: 2,
      ts: nowIso,
      type: "agent_step",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      step: input.step,
      phase: input.phase,
      summary: input.summary,
      approachesTried: [],
      actionToolName: input.actionToolName,
      endStatus: input.endStatus,
    };

    this.appendTimelineEvent(event);
  }

  recordRunLedger(clientId: string, input: RunLedgerRecordInput): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: RunLedgerEvent = {
      v: 2,
      ts: nowIso,
      type: "run_ledger",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId: input.runId,
      runPath: input.runPath,
      state: input.state,
      status: input.status,
      summary: input.summary,
    };

    this.appendTimelineEvent(event);
  }

  recordTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: TaskSummaryEvent = {
      v: 2,
      ts: nowIso,
      type: "task_summary",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId: input.runId,
      runPath: input.runPath,
      status: input.status,
      summary: input.summary,
    };

    this.appendTimelineEvent(event);

    if (this.onTaskSummaryIndexedCallback && input.summary.trim().length > 0) {
      const callback = this.onTaskSummaryIndexedCallback;
      const callbackData: TaskSummaryIndexData = {
        clientId,
        sessionId: session.id,
        sessionPath: session.sessionPath,
        runId: input.runId,
        runPath: input.runPath,
        status: input.status,
        summary: input.summary,
        timestamp: nowIso,
      };
      this.enqueueBackgroundTask(async () => {
        await callback(callbackData);
      });
    }
  }

  recordSystemEventOutcome(clientId: string, input: SystemEventOutcomeRecordInput): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: SystemEventProcessedEvent = {
      v: 2,
      ts: nowIso,
      type: "system_event_processed",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId: input.runId,
      source: input.source,
      event: input.event,
      eventId: input.eventId,
      status: input.status,
      note: input.note,
    };

    this.appendTimelineEvent(event);
  }

  recordAssistantFeedback(clientId: string, runId: string, _sessionId: string, message: string): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: AssistantFeedbackEvent = {
      v: 2,
      ts: nowIso,
      type: "assistant_feedback",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      message,
    };

    this.appendTimelineEvent(event);
  }

  getPromptMemoryContext(): PromptMemoryContext {
    return {
      conversationTurns: this.currentSession?.getConversationTurns() ?? [],
      previousSessionSummary: this.currentSession?.handoffSummary ?? "",
    };
  }

  setStaticTokenBudget(tokens: number): void {
    this.staticTokenBudget = tokens;
  }

  getSessionStatus(): SessionStatus | null {
    if (!this.currentSession) return null;

    const dynamicTokens = this.estimateDynamicTokens(this.currentSession);
    const available = Math.max(1, this.contextTokenLimit - this.staticTokenBudget);
    const contextPercent = Math.min(100, (dynamicTokens / available) * 100);

    const turns = this.currentSession.userTurnCount + this.currentSession.assistantTurnCount;

    const startMs = new Date(this.currentSession.startedAt).getTime();
    const nowMs = this.nowProvider().getTime();
    const sessionAgeMinutes = Math.max(0, Math.floor((nowMs - startMs) / 60_000));

    return { contextPercent, turns, sessionAgeMinutes };
  }

  flushBackgroundTasks(): Promise<void> {
    return this.backgroundQueue;
  }

  private ensureWritableSession(clientId: string, nowIso: string): InMemorySession {
    this.ensureOpenSession(clientId, nowIso);
    return this.currentSession!;
  }

  private ensureOpenSession(clientId: string, nowIso: string): void {
    if (this.currentSession) return;
    this.createNewSession(clientId, nowIso);
  }

  private restoreActiveSession(clientId: string): void {
    const nowIso = this.nowIso();
    const attempted = new Set<string>();

    const tryRestore = (
      candidate: ActiveSessionInfo | null,
      source: "active_row" | "marker" | "recovery_candidate",
    ): InMemorySession | null => {
      if (!candidate) return null;
      const key = `${candidate.sessionId}:${candidate.sessionPath}`;
      if (attempted.has(key)) return null;
      attempted.add(key);

      const restoredFromCandidate = this.persistence.replaySessionFile(
        this.persistence.resolveSessionAbsolutePath(candidate.sessionPath),
      );
      if (restoredFromCandidate && restoredFromCandidate.clientId === clientId) {
        return restoredFromCandidate;
      }

      if (candidate.sessionPath.endsWith(".jsonl")) {
        const markdownPath = `${candidate.sessionPath.slice(0, -".jsonl".length)}.md`;
        const markdownKey = `${candidate.sessionId}:${markdownPath}`;
        if (!attempted.has(markdownKey)) {
          attempted.add(markdownKey);
          const restoredFromMarkdown = this.persistence.replaySessionFile(
            this.persistence.resolveSessionAbsolutePath(markdownPath),
          );
          if (restoredFromMarkdown && restoredFromMarkdown.clientId === clientId) {
            return restoredFromMarkdown;
          }
        }
      }

      if (restoredFromCandidate?.clientId !== clientId) {
        this.persistence.markSessionCrashed(candidate.sessionId, nowIso, `${source}_restore_failed`);
      }
      return null;
    };

    const fromActive = tryRestore(this.persistence.getActiveSessionInfo(clientId), "active_row");
    const fromMarker = fromActive ?? tryRestore(this.persistence.getActiveSessionInfo(), "marker");

    let restored = fromMarker;
    if (!restored) {
      const candidates = this.persistence.listRecoveryCandidates(clientId, 24);
      for (const candidate of candidates) {
        restored = tryRestore(candidate, "recovery_candidate");
        if (restored) break;
      }
    }

    if (!restored) return;

    restored = this.migrateLegacyJsonlSessionIfNeeded(restored);
    this.currentSession = restored;
    this.persistence.resumeSession(restored.id, clientId, restored.sessionPath, nowIso);
    this.persistence.writeActiveSessionMarker(restored.id, restored.sessionPath);
  }

  private createNewSession(
    clientId: string,
    nowIso: string,
    options?: {
      sessionId?: string;
      sessionPath?: string;
      parentSessionId?: string;
      handoffSummary?: string;
    },
  ): void {
    const sessionId = options?.sessionId ?? randomUUID();
    const sessionPath = options?.sessionPath ?? this.persistence.buildSessionPath(nowIso, sessionId);
    this.currentSession = new InMemorySession(sessionId, clientId, nowIso, sessionPath);
    this.currentSession.handoffSummary = options?.handoffSummary ?? null;

    const openEvent: SessionEvent = {
      v: 2,
      ts: nowIso,
      type: "session_open",
      sessionId,
      sessionPath,
      clientId,
      parentSessionId: options?.parentSessionId,
      handoffSummary: options?.handoffSummary,
    };

    this.persistence.appendEvent(openEvent);
    this.persistence.writeActiveSessionMarker(sessionId, sessionPath);
  }

  private closeSessionInternal(
    session: InMemorySession,
    nowIso: string,
    reason: string,
    options?: {
      handoffSummary?: string;
      nextSessionId?: string;
      nextSessionPath?: string;
    },
  ): void {
    const turns = session.getConversationTurns();
    const tokenAtClose = this.estimateDynamicTokens(session);

    const closeEvent: SessionEvent = {
      v: 2,
      ts: nowIso,
      type: "session_close",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      reason,
      tokenAtClose,
      eventCount: session.getCountableEventCount(),
      handoffSummary: options?.handoffSummary,
      nextSessionId: options?.nextSessionId,
      nextSessionPath: options?.nextSessionPath,
    };

    this.persistence.appendEvent(closeEvent);
    this.persistence.clearActiveSessionMarker();

    if (this.onSessionCloseCallback && turns.length >= MIN_TURNS_FOR_CALLBACK) {
      const cb = this.onSessionCloseCallback;
      const cbData: SessionCloseData = {
        sessionId: session.id,
        clientId: session.clientId,
        turns,
        reason,
      };
      this.enqueueBackgroundTask(async () => {
        await cb(cbData);
      });
    }
  }

  private appendTimelineEvent(event: TimelineEvent): void {
    if (!this.currentSession) return;

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);
  }

  private estimateDynamicTokens(session: InMemorySession): number {
    const turns = session.getConversationTurns();
    const conversationText = turns
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");

    const toolText = this.memoryDetailMode === "debug"
      ? session
          .getToolEvents()
          .map((event) => {
            const status = event.status ? ` status=${event.status}` : "";
            const error = event.errorMessage ? ` error=${event.errorMessage}` : "";
            return `${event.eventType} ${event.toolName}${status} args=${event.args} output=${event.output}${error}`;
          })
          .join("\n")
      : "";

    const estimate =
      this.staticTokenBudget +
      estimateTextTokens(conversationText) +
      estimateTextTokens(toolText) +
      (this.memoryDetailMode === "debug" ? session.estimateToolEventTokens() : 0);

    // Calculated for observability only; not used for forced session rotation.
    return Math.min(estimate, this.contextTokenLimit * 10);
  }

  private enqueueBackgroundTask(task: () => Promise<void>): void {
    this.backgroundQueue = this.backgroundQueue
      .then(task)
      .catch((err) => devWarn("Background memory task failed:", err instanceof Error ? err.message : String(err)));
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }

 
  private migrateLegacyJsonlSessionIfNeeded(session: InMemorySession): InMemorySession {
    if (!session.sessionPath.endsWith(".jsonl")) {
      return session;
    }

    const markdownSessionPath = `${session.sessionPath.slice(0, -".jsonl".length)}.md`;
    const markdownAbsolutePath = this.persistence.resolveSessionAbsolutePath(markdownSessionPath);

    // Idempotent restore path: if markdown already exists and is readable, prefer it.
    if (existsSync(markdownAbsolutePath)) {
      const replayed = this.persistence.replaySessionFile(markdownAbsolutePath);
      if (replayed && replayed.clientId === session.clientId) {
        return replayed;
      }
    }

    const migrated = new InMemorySession(
      session.id,
      session.clientId,
      session.startedAt,
      markdownSessionPath,
    );

    this.persistence.appendEvent({
      v: 2,
      ts: session.startedAt,
      type: "session_open",
      sessionId: session.id,
      sessionPath: markdownSessionPath,
      clientId: session.clientId,
    });

    for (const entry of session.timeline) {
      const migratedEntry: TimelineEvent = {
        ...entry,
        sessionPath: markdownSessionPath,
      };
      this.persistence.appendEvent(migratedEntry);
      migrated.addEntry(migratedEntry);
    }

    const legacyPath = this.persistence.resolveSessionAbsolutePath(session.sessionPath);
    try {
      rmSync(legacyPath, { force: true });
    } catch (err) {
      devWarn("Failed to remove legacy session jsonl file:", err instanceof Error ? err.message : String(err));
    }

    return migrated;
  }
}

export type SessionManagerOptions = MemoryManagerOptions;
export { MemoryManager as SessionManager };
