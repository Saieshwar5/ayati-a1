import { randomUUID } from "node:crypto";
import type {
  AgentStepRecordInput,
  AssistantMessageMetadata,
  AssistantMessageRecordInput,
  AssistantNotificationRecordInput,
  ConversationExchange,
  ConversationTurn,
  MemoryRunHandle,
  PromptMemoryContext,
  PromptSessionEvent,
  SessionInputHandle,
  SessionLifecycleUpdateInput,
  SessionMemory,
  SessionStatus,
  SystemActivityItem,
  SystemEventOutcomeRecordInput,
  SystemEventRecordInput,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  TurnStatusRecordInput,
} from "./types.js";
import type {
  AssistantResponseEvent,
  SessionEvent,
  SessionOpenEvent,
  SystemEventEntry,
  UserMessageEvent,
} from "./session-events.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";
import { SqliteSystemEventStore } from "./system-event-store.js";
import { devWarn } from "../shared/index.js";

const RECENT_SYSTEM_EVENT_LIMIT = 5;
const DEFAULT_SESSION_TIMEZONE = "Asia/Kolkata";

export interface SessionCloseData {
  sessionId: string;
  clientId: string;
  sessionPath: string;
  sessionFilePath: string;
  turns: ConversationTurn[];
  reason: string;
  handoffSummary: string | null;
}

export interface MemoryManagerOptions extends SessionPersistenceOptions {
  now?: () => Date;
  onSessionClose?: (data: SessionCloseData) => void | Promise<void>;
  personalMemorySnapshotProvider?: (clientId: string) => string;
  sessionTimezone?: string;
}

export type SessionManagerOptions = MemoryManagerOptions;

interface HotSessionState {
  clientId: string;
  sessionId: string;
  sessionDate: string;
  sessionPath: string;
  startedAt: string;
  nextSeq: number;
  timeline: TimelineEvent[];
  workRunTriggerSeq: Map<string, number>;
  recentExchanges: ConversationExchange[];
  recentSystemEvents: SystemActivityItem[];
}

type TimelineEvent = UserMessageEvent | AssistantResponseEvent | SystemEventEntry;

export class MemoryManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly systemEventStore: SqliteSystemEventStore;
  private readonly nowProvider: () => Date;
  private readonly onSessionClose?: (data: SessionCloseData) => void | Promise<void>;
  private readonly personalMemorySnapshotProvider?: (clientId: string) => string;
  private readonly sessionTimezone: string;
  private activeClientId = "";
  private currentSession: HotSessionState | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly sessionCloseTasks = new Set<Promise<void>>();

  constructor(options?: MemoryManagerOptions) {
    this.persistence = new SessionPersistence({
      dbPath: options?.dbPath,
      dataDir: options?.dataDir,
    });
    this.systemEventStore = new SqliteSystemEventStore({
      dbPath: options?.dbPath,
      dataDir: options?.dataDir,
    });
    this.nowProvider = options?.now ?? (() => new Date());
    this.onSessionClose = options?.onSessionClose;
    this.personalMemorySnapshotProvider = options?.personalMemorySnapshotProvider;
    this.sessionTimezone = options?.sessionTimezone ?? DEFAULT_SESSION_TIMEZONE;
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.systemEventStore.start();
    this.restoreTodaysSession(clientId);
  }

  async shutdown(): Promise<void> {
    if (this.currentSession) {
      this.persistence.writeActiveSessionMarker(
        this.currentSession.sessionId,
        this.currentSession.sessionPath,
      );
    }
    await this.flushPersistence();
    await Promise.all([...this.sessionCloseTasks]);
    this.persistence.stop();
    this.systemEventStore.stop();
    this.currentSession = null;
  }

  recordUserMessage(clientId: string, userMessage: string): SessionInputHandle {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const seq = nextSessionSeq(session);
    const event: UserMessageEvent = {
      v: 1,
      seq,
      ts: nowIso,
      type: "user_message",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      content: userMessage,
    };

    this.appendTimelineEvent(event);
    session.recentExchanges.push({
      user: {
        seq,
        timestamp: nowIso,
        content: userMessage,
      },
    });
    return { sessionId: session.sessionId, seq };
  }

  recordSystemEvent(clientId: string, input: SystemEventRecordInput): SessionInputHandle {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const seq = nextSessionSeq(session);
    const summary = input.summary?.trim() || `${input.source}:${input.event}`;
    const event: SystemEventEntry = {
      v: 1,
      seq,
      ts: nowIso,
      type: "system_event",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      source: input.source,
      event: input.event,
      eventId: input.eventId,
      summary,
      payload: input.payload,
    };

    this.appendTimelineEvent(event);
    this.pushSystemEvent(session, event);
    this.systemEventStore.recordReceived({
      clientId,
      sessionId: session.sessionId,
      workRunId: null,
      eventId: input.eventId,
      source: input.source,
      eventName: input.event,
      eventClass: input.eventClass ?? "state_changed",
      trustTier: input.trustTier ?? "trusted_system",
      effectLevel: input.effectLevel ?? "observe",
      createdBy: input.createdBy ?? "system",
      requestedAction: input.requestedAction,
      modeApplied: input.modeApplied ?? "analyze_notify",
      approvalState: input.approvalState ?? "not_needed",
      summary,
      payload: input.payload,
      receivedAt: input.triggeredAt ?? nowIso,
    });

    return { sessionId: session.sessionId, seq };
  }

  createWorkRun(clientId: string, input: SessionInputHandle): MemoryRunHandle {
    const session = this.currentSession;
    if (!session || session.clientId !== clientId || session.sessionId !== input.sessionId) {
      throw new Error("Cannot create work run without a matching active session input.");
    }
    const run = {
      sessionId: session.sessionId,
      runId: randomUUID(),
      triggerSeq: input.seq,
    };
    session.workRunTriggerSeq.set(run.runId, input.seq);
    return run;
  }

  recordTurnStatus(_clientId: string, _input: TurnStatusRecordInput): void {
    return;
  }

  recordToolCall(_clientId: string, _input: ToolCallRecordInput): void {
    return;
  }

  recordToolResult(_clientId: string, _input: ToolCallResultRecordInput): void {
    return;
  }

  recordAssistantFinal(
    clientId: string,
    runId: string,
    sessionId: string,
    content: string,
    metadata?: AssistantMessageMetadata,
  ): void {
    this.recordAssistantMessage(clientId, {
      sessionId,
      workRunId: runId,
      content,
      responseKind: metadata?.responseKind,
    });
  }

  recordAssistantMessage(
    clientId: string,
    input: AssistantMessageRecordInput,
  ): void {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const seq = nextSessionSeq(session);
    const event: AssistantResponseEvent = {
      v: 1,
      seq,
      ts: nowIso,
      type: "assistant_response",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      ...(input.workRunId ? { workRunId: input.workRunId } : {}),
      content: input.content,
      responseKind: input.responseKind,
    };

    this.appendTimelineEvent(event);
    const exchange = [...session.recentExchanges].reverse().find((item) => item.assistant === undefined);
    if (exchange) {
      exchange.assistant = {
        seq,
        timestamp: nowIso,
        content: input.content,
        responseKind: input.responseKind,
      };
    }
  }

  recordRunFailure(_clientId: string, _runId: string, _sessionId: string, _message: string): void {
    return;
  }

  recordAgentStep(_clientId: string, _input: AgentStepRecordInput): void {
    return;
  }

  recordSystemEventOutcome(_clientId: string, input: SystemEventOutcomeRecordInput): void {
    this.systemEventStore.recordOutcome({
      workRunId: input.workRunId ?? null,
      eventId: input.eventId,
      status: input.status,
      processedAt: this.nowIso(),
      responseKind: input.responseKind,
      approvalState: input.approvalState,
      note: input.note,
    });
  }

  recordAssistantNotification(_clientId: string, _input: AssistantNotificationRecordInput): void {
    return;
  }

  getPromptMemoryContext(): PromptMemoryContext {
    const session = this.currentSession;
    const clientId = session?.clientId ?? this.activeClientId;
    const recentExchanges = cloneExchanges(session?.recentExchanges ?? []);

    return {
      recentExchanges,
      sessionEvents: buildPromptSessionEvents(session?.timeline ?? []),
      recentSystemEvents: cloneSystemEvents(session?.recentSystemEvents ?? []),
      conversationTurns: flattenExchanges(recentExchanges, session?.sessionPath ?? ""),
      personalMemorySnapshot: this.personalMemorySnapshotProvider?.(clientId) ?? "",
      personalMemories: [],
      activeSessionPath: session?.sessionPath ?? "",
    };
  }

  getSessionStatus(): SessionStatus | null {
    const session = this.currentSession;
    if (!session) return null;

    const startMs = new Date(session.startedAt).getTime();
    const nowMs = this.nowProvider().getTime();
    const sessionAgeMinutes = Math.max(0, Math.floor((nowMs - startMs) / 60_000));
    const turns = session.recentExchanges.reduce((count, exchange) => (
      count + 1 + (exchange.assistant ? 1 : 0)
    ), 0);

    return {
      sessionId: session.sessionId,
      sessionDate: session.sessionDate,
      activeSessionPath: session.sessionPath,
      contextPercent: 0,
      turns,
      sessionAgeMinutes,
      startedAt: session.startedAt,
      handoffPhase: "inactive",
      pendingRotationReason: null,
    };
  }

  updateSessionLifecycle(_clientId: string, _input: SessionLifecycleUpdateInput): void {
    return;
  }

  flushPersistence(): Promise<void> {
    return this.persistenceQueue;
  }

  setStaticTokenBudget(_tokens: number): void {
    return;
  }

  private ensureTodaySession(clientId: string, nowIso: string): HotSessionState {
    const sessionDate = this.getSessionDate(new Date(nowIso));
    if (this.currentSession?.clientId === clientId && this.currentSession.sessionDate === sessionDate) {
      return this.currentSession;
    }

    if (this.currentSession) {
      const reason = this.currentSession.clientId === clientId ? "daily_session_rotated" : "client_session_switched";
      this.scheduleSessionClose(this.currentSession, reason, nowIso, this.persistenceQueue);
    }
    return this.createNewSession(clientId, nowIso, sessionDate);
  }

  private createNewSession(clientId: string, nowIso: string, sessionDate: string): HotSessionState {
    const sessionId = randomUUID();
    const sessionPath = this.persistence.buildSessionPath(sessionDate, sessionId);
    const session: HotSessionState = {
      clientId,
      sessionId,
      sessionDate,
      sessionPath,
      startedAt: nowIso,
      nextSeq: 1,
      timeline: [],
      workRunTriggerSeq: new Map(),
      recentExchanges: [],
      recentSystemEvents: [],
    };
    this.currentSession = session;

    const event: SessionOpenEvent = {
      v: 1,
      ts: nowIso,
      type: "session_open",
      sessionId,
      sessionPath,
      sessionDate,
      clientId,
    };

    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(event));
    this.persistence.writeActiveSessionMarker(sessionId, sessionPath);
    return session;
  }

  private restoreTodaysSession(clientId: string): void {
    const nowIso = this.nowIso();
    const today = this.getSessionDate(new Date(nowIso));
    const candidate = this.persistence.getActiveSessionInfo(clientId);
    const restored = this.restoreCandidate(clientId, today, candidate);
    if (!restored) return;

    this.currentSession = restored;
    this.persistence.resumeSession(restored.sessionId, clientId, restored.sessionPath, nowIso);
    this.persistence.writeActiveSessionMarker(restored.sessionId, restored.sessionPath);
  }

  private restoreCandidate(
    clientId: string,
    today: string,
    candidate: ActiveSessionInfo | null,
  ): HotSessionState | null {
    if (!candidate) return null;

    const events = this.persistence.replaySessionFile(
      this.persistence.resolveSessionAbsolutePath(candidate.sessionPath),
    );
    const open = events.find((event): event is SessionOpenEvent => event.type === "session_open");
    if (!open || open.clientId !== clientId || open.sessionDate !== today) {
      return null;
    }

    const session: HotSessionState = {
      clientId,
      sessionId: open.sessionId,
      sessionDate: open.sessionDate,
      sessionPath: open.sessionPath,
      startedAt: open.ts,
      nextSeq: 1,
      timeline: [],
      workRunTriggerSeq: new Map(),
      recentExchanges: [],
      recentSystemEvents: [],
    };

    for (const event of events) {
      if (event.type === "session_open") {
        continue;
      }
      if (event.type !== "user_message" && event.type !== "assistant_response" && event.type !== "system_event") {
        continue;
      }
      const sequenced = ensureEventSeq(event, session);
      session.timeline.push(sequenced);

      if (sequenced.type === "user_message") {
        session.recentExchanges.push({
          user: {
            seq: sequenced.seq,
            timestamp: sequenced.ts,
            content: sequenced.content,
          },
        });
        continue;
      }

      if (sequenced.type === "assistant_response") {
        const exchange = [...session.recentExchanges].reverse().find((item) => item.assistant === undefined);
        if (exchange) {
          exchange.assistant = {
            seq: sequenced.seq,
            timestamp: sequenced.ts,
            content: sequenced.content,
            responseKind: sequenced.responseKind,
          };
        }
        continue;
      }

      this.pushSystemEvent(session, sequenced);
    }

    return session;
  }

  private appendTimelineEvent(event: TimelineEvent): void {
    if (this.currentSession?.sessionId === event.sessionId) {
      this.currentSession.timeline.push(event);
    }
    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(event));
  }

  private scheduleSessionClose(
    session: HotSessionState,
    reason: string,
    closedAt: string,
    pendingWrites: Promise<void>,
  ): void {
    const task = this.closeSessionAfterWrites(session, reason, closedAt, pendingWrites)
      .catch((err) => {
        devWarn(
          `Session close hook failed session=${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.sessionCloseTasks.delete(task);
      });
    this.sessionCloseTasks.add(task);
  }

  private async closeSessionAfterWrites(
    session: HotSessionState,
    reason: string,
    closedAt: string,
    pendingWrites: Promise<void>,
  ): Promise<void> {
    await pendingWrites;
    const sessionFilePath = this.persistence.resolveSessionAbsolutePath(session.sessionPath);
    const turns = extractConversationTurns(
      this.persistence.replaySessionFile(sessionFilePath),
      session.sessionPath,
    );
    this.persistence.closeSession(session.sessionId, closedAt, reason);
    await this.onSessionClose?.({
      sessionId: session.sessionId,
      clientId: session.clientId,
      sessionPath: session.sessionPath,
      sessionFilePath,
      turns,
      reason,
      handoffSummary: null,
    });
  }

  private enqueuePersistenceTask(task: () => Promise<void>): Promise<void> {
    this.persistenceQueue = this.persistenceQueue
      .then(task)
      .catch(() => {
        // Persistence failures should not crash the agent loop.
      });
    return this.persistenceQueue;
  }

  private pushSystemEvent(session: HotSessionState, event: SystemEventEntry): void {
    session.recentSystemEvents.push({
      seq: event.seq,
      timestamp: event.ts,
      source: event.source,
      event: event.event,
      eventId: event.eventId,
      summary: event.summary,
      responseKind: "notification",
      userVisible: true,
    });
    trimTail(session.recentSystemEvents, RECENT_SYSTEM_EVENT_LIMIT);
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }

  private getSessionDate(date: Date): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.sessionTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  }
}

export { MemoryManager as SessionManager };

function trimTail<T>(items: T[], limit: number): void {
  if (items.length <= limit) return;
  items.splice(0, items.length - limit);
}

function nextSessionSeq(session: HotSessionState): number {
  const seq = session.nextSeq;
  session.nextSeq += 1;
  return seq;
}

function ensureEventSeq<T extends TimelineEvent>(event: T, session: HotSessionState): T {
  if (typeof event.seq === "number" && Number.isInteger(event.seq) && event.seq > 0) {
    session.nextSeq = Math.max(session.nextSeq, event.seq + 1);
    return event;
  }
  return {
    ...event,
    seq: nextSessionSeq(session),
  };
}

function buildPromptSessionEvents(events: TimelineEvent[]): PromptSessionEvent[] {
  return events.flatMap((event): PromptSessionEvent[] => {
    if (!event.seq) {
      return [];
    }
    if (event.type === "user_message") {
      return [{
        type: event.type,
        seq: event.seq,
        timestamp: event.ts,
        content: event.content,
      }];
    }
    if (event.type === "assistant_response") {
      return [{
        type: event.type,
        seq: event.seq,
        timestamp: event.ts,
        ...(event.workRunId ? { workRunId: event.workRunId } : {}),
        content: event.content,
        ...(event.responseKind ? { responseKind: event.responseKind } : {}),
      }];
    }
    return [{
      type: event.type,
      seq: event.seq,
      timestamp: event.ts,
      source: event.source,
      event: event.event,
      eventId: event.eventId,
      summary: event.summary,
    }];
  });
}

function cloneExchanges(exchanges: ConversationExchange[]): ConversationExchange[] {
  return exchanges.map((exchange) => ({
    user: { ...exchange.user },
    ...(exchange.assistant ? { assistant: { ...exchange.assistant } } : {}),
  }));
}

function cloneSystemEvents(events: SystemActivityItem[]): SystemActivityItem[] {
  return events.map((event) => ({ ...event }));
}

function flattenExchanges(exchanges: ConversationExchange[], sessionPath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const exchange of exchanges) {
    turns.push({
      role: "user",
      content: exchange.user.content,
      timestamp: exchange.user.timestamp,
      sessionPath,
      seq: exchange.user.seq,
    });
    if (exchange.assistant) {
      turns.push({
        role: "assistant",
        content: exchange.assistant.content,
        timestamp: exchange.assistant.timestamp,
        sessionPath,
        seq: exchange.assistant.seq,
        assistantResponseKind: exchange.assistant.responseKind,
      });
    }
  }
  return turns;
}

function extractConversationTurns(events: SessionEvent[], fallbackSessionPath: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const event of events) {
    if (event.type === "user_message") {
      turns.push({
        role: "user",
        content: event.content,
        timestamp: event.ts,
        sessionPath: event.sessionPath || fallbackSessionPath,
        seq: event.seq,
      });
      continue;
    }

    if (event.type === "assistant_response") {
      turns.push({
        role: "assistant",
        content: event.content,
        timestamp: event.ts,
        sessionPath: event.sessionPath || fallbackSessionPath,
        seq: event.seq,
        workRunId: event.workRunId,
        assistantResponseKind: event.responseKind,
      });
    }
  }
  return turns;
}
