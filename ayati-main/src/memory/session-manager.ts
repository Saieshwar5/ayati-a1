import { randomUUID } from "node:crypto";
import type {
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  SessionInputHandle,
  AssistantMessageMetadata,
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
  PromptSessionEvent,
  ConversationExchange,
  ConversationTurn,
  SessionLifecycleUpdateInput,
  SystemActivityItem,
  SessionWorkActivitySummary,
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

  recordTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    this.queueTaskSummary(clientId, input);
  }

  queueTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    const enriched = this.enrichTaskSummaryWithSessionRange(clientId, input);
    this.activityStore.upsertFromTaskSummary(taskSummaryToActivityInput(clientId, enriched, this.nowIso()));
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
    const recentSystemEvents = cloneSystemEvents(session?.recentSystemEvents ?? []);
    const activeContextStartSeq = this.resolveActiveContextStartSeq(clientId, session);

    return {
      recentExchanges,
      sessionEvents: buildPromptSessionEvents(session?.timeline ?? []),
      activeContextStartSeq,
      sessionWork: {
        activeContextStartSeq,
        recentActivities: this.buildSessionWorkActivities(clientId, session),
      },
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

  private enrichTaskSummaryWithSessionRange(
    clientId: string,
    input: TaskSummaryRecordInput,
  ): TaskSummaryRecordInput {
    const session = this.currentSession;
    if (!session || session.clientId !== clientId || session.sessionId !== input.sessionId) {
      return input;
    }
    const triggerSeq = input.triggerSeq ?? session.workRunTriggerSeq.get(input.runId);
    const activeContextStartSeq = this.resolveActiveContextStartSeq(clientId, session);
    const discussionEndSeq = input.discussionEndSeq ?? triggerSeq;
    const discussionStartSeq = input.discussionStartSeq
      ?? (discussionEndSeq ? Math.min(activeContextStartSeq, discussionEndSeq) : undefined);
    return {
      ...input,
      ...(triggerSeq ? { triggerSeq } : {}),
      ...(discussionStartSeq ? { discussionStartSeq } : {}),
      ...(discussionEndSeq ? { discussionEndSeq } : {}),
    };
  }

  private resolveActiveContextStartSeq(clientId: string, session: HotSessionState | null): number {
    if (!session) return 1;
    const boundary = this.activityStore.findLatestDurableTaskBoundary(clientId, session.sessionId);
    return boundary?.endSeq ? boundary.endSeq + 1 : 1;
  }

  private buildSessionWorkActivities(
    clientId: string,
    session: HotSessionState | null,
  ): SessionWorkActivitySummary[] {
    if (!session) return [];
    return this.activityStore.listRecentForSession(clientId, session.sessionId, 5).map((activity) => {
      const sessionRanges = activity.discussionRanges.filter((range) => range.sessionId === session.sessionId);
      const lastTouchedSeq = sessionRanges.length > 0
        ? Math.max(...sessionRanges.map((range) => range.endSeq))
        : undefined;
      return {
        activityId: activity.activityId,
        title: activity.title,
        ...(activity.state.status ? { status: activity.state.status } : {}),
        lastTouchedAt: activity.lastTouchedAt,
        ...(lastTouchedSeq ? { lastTouchedSeq } : {}),
        openWork: activity.state.openWork.slice(0, 5),
        topAssets: activity.assets
          .map((asset) => asset.path ?? asset.displayName ?? asset.documentId ?? asset.fileId ?? asset.directoryId ?? asset.uri ?? "")
          .filter(Boolean)
          .slice(0, 8),
        workRunIds: activity.runs
          .filter((run) => run.sessionId === session.sessionId)
          .slice(-5)
          .map((run) => run.runId),
      };
    });
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

      if (sequenced.type === "system_event") {
        this.pushSystemEvent(session, sequenced);
      }
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

function taskSummaryToActivityInput(clientId: string, input: TaskSummaryRecordInput, createdAt: string): ActivityUpsertInput {
  return {
    clientId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    runId: input.runId,
    runPath: input.runPath,
    triggerSeq: input.triggerSeq,
    discussionStartSeq: input.discussionStartSeq,
    discussionEndSeq: input.discussionEndSeq,
    status: input.status,
    taskStatus: input.taskStatus,
    objective: input.objective,
    summary: input.summary,
    progressSummary: input.progressSummary,
    currentFocus: input.currentFocus,
    completedMilestones: input.completedMilestones,
    assumptions: input.assumptions,
    constraints: input.constraints,
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
