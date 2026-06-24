import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
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
  TaskThread,
  TaskThreadBinding,
  TaskThreadContext,
  TaskThreadContextTask,
  TaskThreadRecentSignals,
  TaskThreadStatus,
  TaskSummaryTaskStatus,
} from "./types.js";
import type {
  SessionEvent,
  SessionOpenEvent,
  UserMessageEvent,
  AssistantResponseEvent,
  SystemEventEntry,
  TaskThreadUpdateEvent,
} from "./session-events.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";
import { SqliteSystemEventStore } from "./system-event-store.js";
import { ActivityStore } from "./activity/activity-store.js";
import type { ActivityAssetRef, ActivityUpsertInput } from "./activity/types.js";
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
  taskThreads: Map<string, TaskThread>;
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
    if (enriched.activityId?.trim()) {
      this.activityStore.upsertFromTaskSummary(taskSummaryToActivityInput(clientId, enriched, this.nowIso()));
      return;
    }

    const thread = this.reduceTaskSummaryIntoTaskThread(clientId, enriched);
    if (!thread) {
      return;
    }
    const session = this.currentSession;
    this.persistTaskThreadUpdate(thread, session);

    if (shouldPromoteTaskThreadNow(thread)) {
      const activity = this.activityStore.upsertFromTaskSummary(taskThreadToActivityInput(thread, this.nowIso()));
      const updated = activity
        ? {
            ...thread,
            status: "promoted_to_activity" as const,
            promotedActivityId: activity.activityId,
            lastTouchedAt: this.nowIso(),
          }
        : thread;
      this.currentSession?.taskThreads.set(updated.taskThreadId, updated);
      this.persistTaskThreadUpdate(updated, session);
    }
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
      taskThreadContext: this.buildTaskThreadContext(clientId, session),
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

  private buildTaskThreadContext(clientId: string, session: HotSessionState | null): TaskThreadContext {
    const latestUserMessage = latestUserMessageFromSession(session);
    const active = latestTaskByStatus(session, "active_in_session");
    const suspended = listOpenTaskThreads(session)
      .filter((thread) => thread.status === "suspended_in_session")
      .sort((left, right) => right.lastTouchedAt.localeCompare(left.lastTouchedAt));
    const signals = buildTaskThreadSignals(latestUserMessage, session, [active, ...suspended].filter(isTaskThread));
    const suggestedBinding = suggestTaskThreadBinding({
      latestUserMessage,
      active,
      suspended,
      signals,
    });

    return {
      ...(active ? { activeTask: taskThreadToContextTask(active) } : {}),
      suspendedTasks: suspended.slice(0, 5).map(taskThreadToContextTask),
      recentSignals: signals,
      suggestedBinding,
    };
  }

  private reduceTaskSummaryIntoTaskThread(clientId: string, input: TaskSummaryRecordInput): TaskThread | null {
    const session = this.currentSession;
    if (!session || session.clientId !== clientId || session.sessionId !== input.sessionId) {
      return null;
    }
    if (!shouldTrackTaskSummary(input)) {
      return null;
    }

    const nowIso = this.nowIso();
    const targetThread = selectTaskThreadForSummary(session, input);
    const taskThreadId = targetThread?.taskThreadId ?? input.taskThreadId?.trim() ?? `task_${randomUUID()}`;
    const nextStatus = taskThreadStatusForSummary(input);
    if (nextStatus === "active_in_session") {
      suspendOtherActiveTaskThreads(session, taskThreadId, nowIso);
    }

    const thread = buildNextTaskThread({
      previous: targetThread,
      taskThreadId,
      clientId,
      input,
      nowIso,
      status: nextStatus,
    });
    session.taskThreads.set(thread.taskThreadId, thread);
    return thread;
  }

  private persistTaskThreadUpdate(thread: TaskThread, session = this.currentSession): void {
    if (!session || session.sessionId !== thread.sessionId) {
      return;
    }
    const event: TaskThreadUpdateEvent = {
      v: 1,
      ts: this.nowIso(),
      type: "task_thread_update",
      sessionId: session.sessionId,
      sessionPath: session.sessionPath,
      sessionDate: session.sessionDate,
      taskThread: cloneTaskThread(thread),
    };
    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(event));
  }

  private promoteOpenTaskThreadsForSessionClose(session: HotSessionState, closedAt: string): void {
    for (const thread of listOpenTaskThreads(session)) {
      const activity = this.activityStore.upsertFromTaskSummary(taskThreadToActivityInput(thread, closedAt));
      if (!activity) {
        continue;
      }
      const promoted: TaskThread = {
        ...thread,
        status: "promoted_to_activity",
        promotedActivityId: activity.activityId,
        lastTouchedAt: closedAt,
      };
      session.taskThreads.set(promoted.taskThreadId, promoted);
      this.persistTaskThreadUpdate(promoted, session);
    }
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
      taskThreads: new Map(),
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
      taskThreads: new Map(),
    };

    for (const event of events) {
      if (event.type === "session_open") {
        continue;
      }
      if (event.type === "task_thread_update") {
        session.taskThreads.set(event.taskThread.taskThreadId, cloneTaskThread(event.taskThread));
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
        continue;
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
    this.promoteOpenTaskThreadsForSessionClose(session, closedAt);
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

function latestUserMessageFromSession(session: HotSessionState | null): string {
  const latest = session?.recentExchanges.at(-1);
  return latest?.user.content ?? "";
}

function latestTaskByStatus(session: HotSessionState | null, status: TaskThreadStatus): TaskThread | undefined {
  return listOpenTaskThreads(session)
    .filter((thread) => thread.status === status)
    .sort((left, right) => right.lastTouchedAt.localeCompare(left.lastTouchedAt))[0];
}

function listOpenTaskThreads(session: HotSessionState | null): TaskThread[] {
  if (!session) return [];
  return [...session.taskThreads.values()].filter((thread) => (
    thread.status === "active_in_session" || thread.status === "suspended_in_session"
  ));
}

function isTaskThread(value: TaskThread | undefined): value is TaskThread {
  return value !== undefined;
}

function buildTaskThreadSignals(
  latestUserMessage: string,
  session: HotSessionState | null,
  threads: TaskThread[],
): TaskThreadRecentSignals {
  const previousAssistant = session?.recentExchanges.at(-2)?.assistant ?? session?.recentExchanges.at(-1)?.assistant;
  const mentionedAssetNames = uniqueStrings(
    threads.flatMap((thread) => thread.activityAssets)
      .map((asset) => asset.displayName ?? (asset.path ? basename(asset.path) : ""))
      .filter((name) => name.length > 0 && includesLoose(latestUserMessage, name)),
  );
  const mentionedAssetPaths = uniqueStrings(
    threads.flatMap((thread) => thread.activityAssets)
      .map((asset) => asset.path ?? asset.restore?.filePath ?? asset.restore?.directoryPath ?? "")
      .filter((path) => path.length > 0 && includesLoose(latestUserMessage, path)),
  );
  return {
    latestUserMessage,
    previousAssistantExpectedAnswer: previousAssistant?.responseKind === "feedback",
    hasFollowUpSignal: hasFollowUpSignal(latestUserMessage),
    hasExplicitNewTaskSignal: hasExplicitNewTaskSignal(latestUserMessage),
    mentionedAssetNames,
    mentionedAssetPaths,
  };
}

function suggestTaskThreadBinding(input: {
  latestUserMessage: string;
  active?: TaskThread;
  suspended: TaskThread[];
  signals: TaskThreadRecentSignals;
}): TaskThreadBinding {
  if (input.signals.hasExplicitNewTaskSignal) {
    return {
      mode: "new_task",
      confidence: 0.9,
      reason: "latest user message contains an explicit new-task signal",
    };
  }

  const candidates = [input.active, ...input.suspended]
    .filter(isTaskThread)
    .map((thread) => ({
      thread,
      score: scoreTaskThreadForMessage(thread, input.latestUserMessage, thread.taskThreadId === input.active?.taskThreadId),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.thread.lastTouchedAt.localeCompare(left.thread.lastTouchedAt));

  if (input.signals.previousAssistantExpectedAnswer && input.active) {
    return {
      mode: "continue_task",
      taskThreadId: input.active.taskThreadId,
      confidence: 0.92,
      reason: "previous assistant response expected a user answer for the active task",
    };
  }

  if (input.signals.hasFollowUpSignal && input.active && (candidates[0]?.thread.taskThreadId === input.active.taskThreadId || !candidates[0])) {
    return {
      mode: "continue_task",
      taskThreadId: input.active.taskThreadId,
      confidence: 0.86,
      reason: "follow-up phrasing matched the active open task",
    };
  }

  const [top, second] = candidates;
  if (!top) {
    return {
      mode: "new_task",
      confidence: input.active ? 0.62 : 0.86,
      reason: input.active ? "message did not match active or suspended open tasks" : "no open task threads are available",
    };
  }

  if (second && top.score >= 0.42 && top.score - second.score < 0.12) {
    return {
      mode: "ambiguous",
      confidence: top.score,
      reason: "multiple open task threads matched the latest message",
    };
  }

  if (top.score >= 0.52) {
    const isActive = top.thread.taskThreadId === input.active?.taskThreadId;
    return {
      mode: isActive ? "continue_task" : "switch_task",
      taskThreadId: top.thread.taskThreadId,
      confidence: top.score,
      reason: isActive ? "latest message matched active open task" : "latest message matched a suspended open task",
    };
  }

  if (input.signals.hasFollowUpSignal && input.active) {
    return {
      mode: "continue_task",
      taskThreadId: input.active.taskThreadId,
      confidence: 0.72,
      reason: "follow-up phrasing defaults to the active open task",
    };
  }

  return {
    mode: "new_task",
    confidence: 0.74,
    reason: "open task matches were below continuation threshold",
  };
}

function scoreTaskThreadForMessage(thread: TaskThread, message: string, isActive: boolean): number {
  const tokens = tokenize(message);
  if (tokens.size === 0) return isActive ? 0.18 : 0;
  const searchable = [
    thread.objective,
    thread.summary,
    thread.nextAction,
    ...thread.openWork,
    ...thread.blockers,
    ...thread.keyFacts,
    ...thread.evidence,
    ...thread.toolsUsed,
    ...thread.activityAssets.flatMap((asset) => [
      asset.displayName,
      asset.path,
      asset.restore?.filePath,
      asset.restore?.directoryPath,
      asset.documentId,
      asset.fileId,
      asset.directoryId,
    ]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
  const overlap = tokenOverlap(tokens, tokenize(searchable));
  const exactAssetBoost = thread.activityAssets.some((asset) => {
    const labels = [asset.displayName, asset.path, asset.restore?.filePath, asset.restore?.directoryPath]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return labels.some((label) => includesLoose(message, label) || includesLoose(message, basename(label)));
  }) ? 0.35 : 0;
  const activeBoost = isActive && hasFollowUpSignal(message) ? 0.28 : isActive ? 0.08 : 0;
  return Math.min(0.99, Number((overlap + exactAssetBoost + activeBoost).toFixed(3)));
}

function taskThreadToContextTask(thread: TaskThread): TaskThreadContextTask {
  return {
    taskThreadId: thread.taskThreadId,
    status: thread.status,
    ...(thread.taskStatus ? { taskStatus: thread.taskStatus } : {}),
    objective: thread.objective,
    ...(thread.summary ? { summary: thread.summary } : {}),
    completedWork: thread.completedWork.slice(-6),
    openWork: thread.openWork.slice(0, 6),
    blockers: thread.blockers.slice(0, 5),
    keyFacts: thread.keyFacts.slice(-8),
    evidence: thread.evidence.slice(-6),
    toolsUsed: thread.toolsUsed.slice(-10),
    activityAssets: thread.activityAssets.slice(0, 8),
    topAssets: topTaskThreadAssetLabels(thread),
    runIds: thread.runIds.slice(-5),
    discussionRanges: thread.discussionRanges.slice(-3),
    ...(thread.nextAction ? { nextAction: thread.nextAction } : {}),
    ...(thread.lastAssistantQuestion ? { lastAssistantQuestion: thread.lastAssistantQuestion } : {}),
    lastTouchedAt: thread.lastTouchedAt,
  };
}

function shouldTrackTaskSummary(input: TaskSummaryRecordInput): boolean {
  if (input.taskThreadId?.trim()) return true;
  if (input.taskStatus && input.taskStatus !== "done") return true;
  if ((input.toolsUsed?.length ?? 0) > 0) return true;
  if ((input.activityAssets?.length ?? 0) > 0 || (input.attachmentNames?.length ?? 0) > 0) return true;
  if ((input.openWork?.length ?? 0) > 0 || (input.blockers?.length ?? 0) > 0) return true;
  return false;
}

function selectTaskThreadForSummary(session: HotSessionState, input: TaskSummaryRecordInput): TaskThread | undefined {
  const explicit = input.taskThreadId?.trim();
  if (explicit) {
    return session.taskThreads.get(explicit);
  }
  if (input.taskBindingMode === "new_task" || input.taskBindingMode === "ambiguous") {
    return undefined;
  }
  return latestTaskByStatus(session, "active_in_session");
}

function taskThreadStatusForSummary(input: TaskSummaryRecordInput): TaskThreadStatus {
  if (input.taskStatus === "done") {
    return "closed_done";
  }
  return "active_in_session";
}

function suspendOtherActiveTaskThreads(session: HotSessionState, activeTaskThreadId: string, at: string): void {
  for (const thread of session.taskThreads.values()) {
    if (thread.taskThreadId === activeTaskThreadId || thread.status !== "active_in_session") {
      continue;
    }
    session.taskThreads.set(thread.taskThreadId, {
      ...thread,
      status: "suspended_in_session",
      lastTouchedAt: at,
    });
  }
}

function buildNextTaskThread(input: {
  previous: TaskThread | undefined;
  taskThreadId: string;
  clientId: string;
  input: TaskSummaryRecordInput;
  nowIso: string;
  status: TaskThreadStatus;
}): TaskThread {
  const previous = input.previous;
  const summary = input.input.summary?.trim() || input.input.progressSummary?.trim() || previous?.summary;
  const taskStatus = input.input.taskStatus;
  const assets = mergeTaskAssets(previous?.activityAssets ?? [], normalizeSummaryAssetPaths(input.input.activityAssets) ?? []);
  const runHistory = appendTaskRun(previous?.runHistory ?? [], {
    runId: input.input.runId,
    runPath: absoluteSummaryPath(input.input.runPath),
    runStatus: input.input.runStatus ?? input.input.status ?? "completed",
    ...(taskStatus ? { taskStatus } : {}),
    summary: summary ?? "",
    toolsUsed: uniqueStrings(input.input.toolsUsed ?? []),
    createdAt: input.nowIso,
  });
  const openWork = taskStatus === "done"
    ? []
    : mergeFront(input.input.openWork ?? [], previous?.openWork ?? [], 12);
  const blockers = taskStatus === "done"
    ? []
    : mergeFront(input.input.blockers ?? [], previous?.blockers ?? [], 10);
  return {
    taskThreadId: input.taskThreadId,
    clientId: input.clientId,
    sessionId: input.input.sessionId,
    status: input.status,
    ...(taskStatus ? { taskStatus } : previous?.taskStatus ? { taskStatus: previous.taskStatus } : {}),
    objective: input.input.objective?.trim() || previous?.objective || input.input.userMessage?.trim() || "Open task",
    ...(summary ? { summary } : {}),
    completedWork: mergeTail(previous?.completedWork ?? [], input.input.completedMilestones ?? [], 12),
    openWork,
    blockers,
    keyFacts: mergeTail(previous?.keyFacts ?? [], input.input.keyFacts ?? [], 20),
    evidence: mergeTail(previous?.evidence ?? [], input.input.evidence ?? [], 16),
    toolsUsed: mergeTail(previous?.toolsUsed ?? [], input.input.toolsUsed ?? [], 20),
    activityAssets: assets,
    runIds: mergeTail(previous?.runIds ?? [], [input.input.runId], 12),
    runHistory,
    discussionRanges: mergeTaskDiscussionRanges(
      previous?.discussionRanges ?? [],
      buildTaskDiscussionRange(input.input, previous !== undefined),
    ),
    ...(input.input.nextAction ? { nextAction: input.input.nextAction } : previous?.nextAction ? { nextAction: previous.nextAction } : {}),
    ...(input.input.taskStatus === "needs_user_input" && input.input.userInputNeeded
      ? { lastAssistantQuestion: input.input.userInputNeeded }
      : previous?.lastAssistantQuestion
        ? { lastAssistantQuestion: previous.lastAssistantQuestion }
        : {}),
    ...(previous?.promotedActivityId ? { promotedActivityId: previous.promotedActivityId } : {}),
    createdAt: previous?.createdAt ?? input.nowIso,
    lastTouchedAt: input.nowIso,
  };
}

function buildTaskDiscussionRange(input: TaskSummaryRecordInput, isFollowUp: boolean): TaskThread["discussionRanges"][number] | null {
  const startSeq = input.discussionStartSeq ?? input.triggerSeq;
  const endSeq = input.discussionEndSeq ?? input.triggerSeq;
  if (!startSeq || !endSeq) {
    return null;
  }
  return {
    sessionId: input.sessionId,
    startSeq: Math.min(startSeq, endSeq),
    endSeq: Math.max(startSeq, endSeq),
    reason: isFollowUp ? "follow_up" : "initial_discussion",
  };
}

function mergeTaskDiscussionRanges(
  previous: TaskThread["discussionRanges"],
  next: TaskThread["discussionRanges"][number] | null,
): TaskThread["discussionRanges"] {
  if (!next) return previous;
  const output = [...previous];
  const last = output[output.length - 1];
  if (last && last.sessionId === next.sessionId && next.startSeq <= last.endSeq + 1) {
    output[output.length - 1] = {
      ...last,
      endSeq: Math.max(last.endSeq, next.endSeq),
      reason: last.reason === "initial_discussion" ? last.reason : next.reason,
    };
    return output;
  }
  output.push(next);
  return output.slice(-12);
}

function shouldPromoteTaskThreadNow(thread: TaskThread): boolean {
  return thread.status === "closed_done";
}

function cloneTaskThread(thread: TaskThread): TaskThread {
  return {
    ...thread,
    completedWork: [...thread.completedWork],
    openWork: [...thread.openWork],
    blockers: [...thread.blockers],
    keyFacts: [...thread.keyFacts],
    evidence: [...thread.evidence],
    toolsUsed: [...thread.toolsUsed],
    activityAssets: thread.activityAssets.map((asset) => ({ ...asset })),
    runIds: [...thread.runIds],
    runHistory: thread.runHistory.map((run) => ({ ...run, toolsUsed: [...run.toolsUsed] })),
    discussionRanges: thread.discussionRanges.map((range) => ({ ...range })),
  };
}

function topTaskThreadAssetLabels(thread: TaskThread): string[] {
  return thread.activityAssets
    .map((asset) => asset.path ?? asset.displayName ?? asset.documentId ?? asset.fileId ?? asset.directoryId ?? asset.uri ?? "")
    .filter(Boolean)
    .slice(0, 8);
}

function mergeTaskAssets(previous: ActivityAssetRef[], next: ActivityAssetRef[]): ActivityAssetRef[] {
  const byKey = new Map<string, ActivityAssetRef>();
  for (const asset of [...previous, ...next]) {
    const key = asset.assetId
      || asset.path
      || asset.restore?.filePath
      || asset.restore?.directoryPath
      || asset.documentId
      || asset.fileId
      || asset.directoryId
      || asset.displayName
      || `${asset.kind}:${byKey.size}`;
    byKey.set(key, {
      ...byKey.get(key),
      ...asset,
    });
  }
  return [...byKey.values()].slice(-40);
}

function appendTaskRun(
  previous: TaskThread["runHistory"],
  next: TaskThread["runHistory"][number],
): TaskThread["runHistory"] {
  const withoutExisting = previous.filter((run) => run.runId !== next.runId);
  return [...withoutExisting, next].slice(-12);
}

function mergeFront(newValues: string[], previousValues: string[], limit: number): string[] {
  return uniqueStrings([...normalizeStringList(newValues), ...normalizeStringList(previousValues)]).slice(0, limit);
}

function mergeTail(previousValues: string[], newValues: string[], limit: number): string[] {
  return uniqueStrings([...normalizeStringList(previousValues), ...normalizeStringList(newValues)]).slice(-limit);
}

function normalizeStringList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function hasFollowUpSignal(message: string): boolean {
  return /\b(continue|resume|again|same|that|this|it|previous|last|earlier|follow up|next|finish|carry on|do the rest|make it|change it|update it)\b/i.test(message);
}

function hasExplicitNewTaskSignal(message: string): boolean {
  return /\b(new|different|start over|from scratch|unrelated|another)\b/i.test(message);
}

function includesLoose(haystack: string, needle: string): boolean {
  const normalizedNeedle = needle.trim().toLowerCase();
  if (!normalizedNeedle) return false;
  const normalizedHaystack = haystack.toLowerCase();
  return normalizedHaystack.includes(normalizedNeedle)
    || normalizedHaystack.includes(basename(normalizedNeedle));
}

function tokenize(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) {
    if (right.has(token)) {
      matches += 1;
    }
  }
  return Math.min(0.7, matches / Math.max(3, left.size));
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "about",
  "what",
  "when",
  "where",
  "this",
  "that",
  "please",
  "task",
]);

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

function taskThreadToActivityInput(thread: TaskThread, createdAt: string): ActivityUpsertInput {
  const latestRun = thread.runHistory[thread.runHistory.length - 1];
  return {
    clientId: thread.clientId,
    sessionId: thread.sessionId,
    runId: latestRun?.runId ?? thread.runIds[thread.runIds.length - 1] ?? thread.taskThreadId,
    runPath: latestRun?.runPath ?? "",
    triggerSeq: thread.discussionRanges.at(-1)?.endSeq,
    discussionStartSeq: thread.discussionRanges[0]?.startSeq,
    discussionEndSeq: thread.discussionRanges.at(-1)?.endSeq,
    status: latestRun?.runStatus ?? "completed",
    taskStatus: thread.taskStatus,
    objective: thread.objective,
    summary: thread.summary ?? thread.objective,
    progressSummary: thread.summary,
    completedMilestones: thread.completedWork,
    openWork: thread.openWork,
    blockers: thread.blockers,
    keyFacts: thread.keyFacts,
    evidence: thread.evidence,
    toolsUsed: thread.toolsUsed,
    nextAction: thread.nextAction,
    activityAssets: thread.activityAssets,
    createdAt,
  };
}

function taskSummaryToActivityInput(clientId: string, input: TaskSummaryRecordInput, createdAt: string): ActivityUpsertInput {
  return {
    clientId,
    activityId: input.activityId,
    sessionId: input.sessionId,
    runId: input.runId,
    runPath: absoluteSummaryPath(input.runPath),
    triggerSeq: input.triggerSeq,
    discussionStartSeq: input.discussionStartSeq,
    discussionEndSeq: input.discussionEndSeq,
    status: input.runStatus ?? input.status ?? "completed",
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
    failureSummary: input.failureSummary,
    attachmentNames: input.attachmentNames,
    activityAssets: normalizeSummaryAssetPaths(input.activityAssets),
    createdAt,
  };
}

function normalizeSummaryAssetPaths(assets: ActivityAssetRef[] | undefined): ActivityAssetRef[] | undefined {
  return assets?.map((asset) => ({
    ...asset,
    ...(asset.path ? { path: absoluteSummaryPath(asset.path) } : {}),
    sourceRunPath: absoluteSummaryPath(asset.sourceRunPath),
    ...(asset.restore ? { restore: {
      ...asset.restore,
      ...(asset.restore.filePath ? { filePath: absoluteSummaryPath(asset.restore.filePath) } : {}),
      ...(asset.restore.directoryPath ? { directoryPath: absoluteSummaryPath(asset.restore.directoryPath) } : {}),
      ...(asset.restore.manifestPath ? { manifestPath: absoluteSummaryPath(asset.restore.manifestPath) } : {}),
    } } : {}),
  }));
}

function absoluteSummaryPath(path: string): string {
  if (!path) {
    return path;
  }
  return isAbsolute(path) ? path : resolve(path);
}

export type SessionManagerOptions = MemoryManagerOptions;
export { MemoryManager as SessionManager };
