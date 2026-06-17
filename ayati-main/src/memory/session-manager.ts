import { randomUUID } from "node:crypto";
import type {
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  AssistantMessageRecordInput,
  TurnStatusRecordInput,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  TaskSummaryRecordInput,
  SystemEventRecordInput,
  SystemEventOutcomeRecordInput,
  AssistantNotificationRecordInput,
  PromptMemoryContext,
  ConversationExchange,
  ConversationTurn,
  SessionLifecycleUpdateInput,
  SystemActivityItem,
} from "./types.js";
import type {
  SessionEvent,
  SessionOpenEvent,
  UserMessageEvent,
  AssistantResponseEvent,
  SystemEventEntry,
} from "./session-events.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";
import { SqliteSystemEventStore } from "./system-event-store.js";
import { ActivityStore } from "./activity/activity-store.js";
import type { ActivityUpsertInput } from "./activity/types.js";
import { devWarn } from "../shared/index.js";

const RECENT_EXCHANGE_LIMIT = 5;
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
  activityStore?: ActivityStore;
}

interface HotSessionState {
  clientId: string;
  sessionId: string;
  sessionDate: string;
  sessionPath: string;
  startedAt: string;
  recentExchanges: ConversationExchange[];
  recentSystemEvents: SystemActivityItem[];
}

type TimelineEvent = UserMessageEvent | AssistantResponseEvent | SystemEventEntry;

export class MemoryManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly systemEventStore: SqliteSystemEventStore;
  private readonly activityStore: ActivityStore;
  private readonly ownsActivityStore: boolean;
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
    this.activityStore = options?.activityStore ?? new ActivityStore({
      dbPath: options?.dbPath,
      dataDir: options?.dataDir,
      now: options?.now,
    });
    this.ownsActivityStore = !options?.activityStore;
    this.nowProvider = options?.now ?? (() => new Date());
    this.onSessionClose = options?.onSessionClose;
    this.personalMemorySnapshotProvider = options?.personalMemorySnapshotProvider;
    this.sessionTimezone = options?.sessionTimezone ?? DEFAULT_SESSION_TIMEZONE;
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.systemEventStore.start();
    this.activityStore.start();
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
    if (this.ownsActivityStore) {
      this.activityStore.stop();
    }
    this.currentSession = null;
  }

  beginRun(clientId: string, userMessage: string): MemoryRunHandle {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const runId = randomUUID();
    const event: UserMessageEvent = {
      v: 1,
      ts: nowIso,
      type: "user_message",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      runId,
      content: userMessage,
    };

    this.appendTimelineEvent(event);
    session.recentExchanges.push({
      runId,
      user: {
        timestamp: nowIso,
        content: userMessage,
      },
    });
    trimTail(session.recentExchanges, RECENT_EXCHANGE_LIMIT);

    return { sessionId: session.sessionId, runId };
  }

  beginSystemRun(clientId: string, input: SystemEventRecordInput): MemoryRunHandle {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const runId = randomUUID();
    const summary = input.summary?.trim() || `${input.source}:${input.event}`;
    const event: SystemEventEntry = {
      v: 1,
      ts: nowIso,
      type: "system_event",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      runId,
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
      runId,
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

    return { sessionId: session.sessionId, runId };
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
    _sessionId: string,
    content: string,
    metadata?: AssistantMessageRecordInput,
  ): void {
    const nowIso = this.nowIso();
    const session = this.ensureTodaySession(clientId, nowIso);
    const event: AssistantResponseEvent = {
      v: 1,
      ts: nowIso,
      type: "assistant_response",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      runId,
      content,
      responseKind: metadata?.responseKind,
    };

    this.appendTimelineEvent(event);
    const exchange = session.recentExchanges.find((item) => item.runId === runId);
    if (exchange) {
      exchange.assistant = {
        timestamp: nowIso,
        content,
        responseKind: metadata?.responseKind,
      };
      trimTail(session.recentExchanges, RECENT_EXCHANGE_LIMIT);
    }
  }

  recordRunFailure(_clientId: string, _runId: string, _sessionId: string, _message: string): void {
    return;
  }

  recordAgentStep(_clientId: string, _input: AgentStepRecordInput): void {
    return;
  }

  recordTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    this.queueTaskSummary(clientId, input);
  }

  queueTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    if (
      (input.toolsUsed?.length ?? 0) === 0
      && !input.activityId
      && (input.activityAssets?.length ?? 0) === 0
      && (input.attachmentNames?.length ?? 0) === 0
    ) {
      return;
    }
    this.activityStore.upsertFromTaskSummary(taskSummaryToActivityInput(clientId, input, this.nowIso()));
  }

  recordSystemEventOutcome(_clientId: string, input: SystemEventOutcomeRecordInput): void {
    this.systemEventStore.recordOutcome({
      runId: input.runId,
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
    const recentSystemEvents = cloneSystemEvents(session?.recentSystemEvents ?? []);

    return {
      recentExchanges,
      recentSystemEvents,
      conversationTurns: flattenExchanges(recentExchanges, session?.sessionPath ?? ""),
      personalMemorySnapshot: this.personalMemorySnapshotProvider?.(clientId) ?? "",
      personalMemories: [],
      continuity: { mode: "new", confidence: 0, reasons: ["continuity resolver runs inside the agent loop"] },
      activeSessionPath: session?.sessionPath ?? "",
      recentTaskSummaries: [],
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

  getActivityStore(): ActivityStore {
    return this.activityStore;
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
      recentExchanges: [],
      recentSystemEvents: [],
    };

    for (const event of events) {
      if (event.type === "user_message") {
        session.recentExchanges.push({
          runId: event.runId,
          user: {
            timestamp: event.ts,
            content: event.content,
          },
        });
        trimTail(session.recentExchanges, RECENT_EXCHANGE_LIMIT);
        continue;
      }

      if (event.type === "assistant_response") {
        const exchange = session.recentExchanges.find((item) => item.runId === event.runId);
        if (exchange) {
          exchange.assistant = {
            timestamp: event.ts,
            content: event.content,
            responseKind: event.responseKind,
          };
        }
        continue;
      }

      if (event.type === "system_event") {
        this.pushSystemEvent(session, event);
      }
    }

    return session;
  }

  private appendTimelineEvent(event: TimelineEvent): void {
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

function trimTail<T>(items: T[], limit: number): void {
  if (items.length <= limit) return;
  items.splice(0, items.length - limit);
}

function cloneExchanges(exchanges: ConversationExchange[]): ConversationExchange[] {
  return exchanges.map((exchange) => ({
    runId: exchange.runId,
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
      runId: exchange.runId,
    });
    if (exchange.assistant) {
      turns.push({
        role: "assistant",
        content: exchange.assistant.content,
        timestamp: exchange.assistant.timestamp,
        sessionPath,
        runId: exchange.runId,
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
        runId: event.runId,
      });
      continue;
    }

    if (event.type === "assistant_response") {
      turns.push({
        role: "assistant",
        content: event.content,
        timestamp: event.ts,
        sessionPath: event.sessionPath || fallbackSessionPath,
        runId: event.runId,
        assistantResponseKind: event.responseKind,
      });
    }
  }
  return turns;
}

function taskSummaryToActivityInput(clientId: string, input: TaskSummaryRecordInput, createdAt: string): ActivityUpsertInput {
  return {
    clientId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    runId: input.runId,
    runPath: input.runPath,
    status: input.status,
    taskStatus: input.taskStatus,
    objective: input.objective,
    summary: input.summary,
    progressSummary: input.progressSummary,
    currentFocus: input.currentFocus,
    completedMilestones: input.completedMilestones,
    openWork: input.openWork,
    blockers: input.blockers,
    keyFacts: input.keyFacts,
    evidence: input.evidence,
    userInputNeeded: input.userInputNeeded,
    userMessage: input.userMessage,
    assistantResponse: input.assistantResponse,
    actionType: input.actionType,
    entityHints: input.entityHints,
    toolsUsed: input.toolsUsed,
    nextAction: input.nextAction,
    attachmentNames: input.attachmentNames,
    activityAssets: input.activityAssets,
    createdAt,
  };
}

export type SessionManagerOptions = MemoryManagerOptions;
export { MemoryManager as SessionManager };
