import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveRotationTimezone,
  shouldPrepareSessionHandoff,
  shouldRotateSessionForContext,
} from "../ivec/session-rotation-policy.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devWarn } from "../shared/index.js";
import { buildSessionHandoff } from "./session-handoff.js";
import { formatConversationTurnInline } from "./conversation-turn-format.js";
import type {
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  AssistantMessageRecordInput,
  AssistantResponseKind,
  FeedbackKind,
  TurnStatusRecordInput,
  CreateSessionInput,
  CreateSessionResult,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  RunLedgerRecordInput,
  ActiveAttachmentsRecordInput,
  TaskSummaryRecordInput,
  SystemEventRecordInput,
  SystemEventOutcomeRecordInput,
  AssistantNotificationRecordInput,
  PromptMemoryContext,
  ConversationTurn,
  ActiveAttachmentRecord,
  SessionLifecycleUpdateInput,
  SessionRotationReason,
  TaskSummaryStopReason,
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
  ActiveAttachmentsEvent,
  TaskSummaryEvent,
  AssistantFeedbackEvent,
  AssistantNotificationEvent,
  FeedbackOpenedEvent,
  FeedbackResolvedEvent,
  SystemEventReceivedEvent,
  SystemEventProcessedEvent,
} from "./session-events.js";
import { InMemorySession } from "./session.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";
import { SqliteSystemEventStore } from "./system-event-store.js";

const MIN_TURNS_FOR_CALLBACK = 2;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 120_000;

export interface SessionCloseData {
  sessionId: string;
  clientId: string;
  turns: ConversationTurn[];
  reason: string;
  handoffSummary: string | null;
}

export interface TaskSummaryIndexData {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  runId: string;
  runPath: string;
  status: "completed" | "failed" | "stuck";
  taskStatus?: "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input";
  objective?: string;
  summary: string;
  progressSummary?: string;
  currentFocus?: string;
  completedMilestones?: string[];
  openWork?: string[];
  blockers?: string[];
  keyFacts?: string[];
  evidence?: string[];
  userInputNeeded?: string;
  workMode?: string;
  userMessage?: string;
  assistantResponse?: string;
  approach?: string;
  sessionContextSummary?: string;
  dependentTaskRunId?: string;
  assistantResponseKind?: AssistantResponseKind;
  feedbackKind?: FeedbackKind;
  feedbackLabel?: string;
  actionType?: string;
  entityHints?: string[];
  goalDoneWhen?: string[];
  goalRequiredEvidence?: string[];
  nextAction?: string;
  stopReason?: TaskSummaryStopReason;
  attachmentNames?: string[];
  timestamp: string;
}

export interface HandoffSummaryIndexData {
  clientId: string;
  sessionId: string;
  sessionPath: string;
  nextSessionId?: string;
  nextSessionPath?: string;
  reason?: string;
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
  | ActiveAttachmentsEvent
  | TaskSummaryEvent
  | AssistantFeedbackEvent
  | AssistantNotificationEvent
  | FeedbackOpenedEvent
  | FeedbackResolvedEvent
  | SystemEventReceivedEvent
  | SystemEventProcessedEvent;

interface PreparedTaskSummaryPublication {
  event: TaskSummaryEvent;
  callbackData: TaskSummaryIndexData | null;
}

export class MemoryManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly systemEventStore: SqliteSystemEventStore;
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
  private persistenceQueue: Promise<void> = Promise.resolve();

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
    this.onSessionCloseCallback = options?.onSessionClose;
    this.onTaskSummaryIndexedCallback = options?.onTaskSummaryIndexed;
    this.onHandoffSummaryIndexedCallback = options?.onHandoffSummaryIndexed;
    this.contextTokenLimit = options?.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
    this.memoryDetailMode = options?.memoryDetailMode ?? "compact";
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.systemEventStore.start();
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

    await this.flushAllQueues();

    this.persistence.stop();
    this.systemEventStore.stop();
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
      runId,
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
    this.systemEventStore.recordReceived({
      clientId,
      sessionId: session.id,
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
      summary: input.summary?.trim() || `${input.source}:${input.event}`,
      payload: input.payload,
      receivedAt: input.triggeredAt ?? nowIso,
    });
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
    const normalizedReason = this.normalizeRotationReason(reason);
    const handoffSummary = input.handoffSummary?.trim()
      || this.finalizeSessionHandoff(previousSession, nowIso, input.timezone ?? null, normalizedReason).summary;
    const nextSessionId = randomUUID();
    const nextSessionPath = this.persistence.buildSessionPath(nowIso, nextSessionId);
    const carriedAttachments = previousSession.getActiveAttachmentRecords(5);

    if (handoffSummary && this.onHandoffSummaryIndexedCallback) {
      const callback = this.onHandoffSummaryIndexedCallback;
      const callbackData: HandoffSummaryIndexData = {
        clientId,
        sessionId: previousSession.id,
        sessionPath: previousSession.sessionPath,
        nextSessionId,
        nextSessionPath,
        reason,
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

    if (carriedAttachments.length > 0) {
      const event: ActiveAttachmentsEvent = {
        v: 2,
        ts: nowIso,
        type: "active_attachments",
        sessionId: active.id,
        sessionPath: active.sessionPath,
        runId: input.runId,
        runPath: carriedAttachments[0]?.runPath ?? active.sessionPath,
        action: "restored",
        attachments: carriedAttachments.map((attachment) => ({
          manifest: attachment.manifest,
          summary: attachment.summary,
          ...(attachment.detail ? { detail: attachment.detail } : {}),
        })),
      };
      this.appendTimelineEvent(event);
    }

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

  recordAssistantFinal(
    clientId: string,
    runId: string,
    _sessionId: string,
    content: string,
    metadata?: AssistantMessageRecordInput,
  ): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: AssistantMessageEvent = {
      v: 2,
      ts: nowIso,
      type: "assistant_message",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId,
      content,
      responseKind: metadata?.responseKind,
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

  recordActiveAttachments(clientId: string, input: ActiveAttachmentsRecordInput): void {
    if (input.attachments.length === 0) {
      return;
    }
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: ActiveAttachmentsEvent = {
      v: 2,
      ts: nowIso,
      type: "active_attachments",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      runId: input.runId,
      runPath: input.runPath,
      action: input.action,
      attachments: input.attachments.map((attachment) => ({
        manifest: attachment.manifest,
        summary: attachment.summary,
        ...(attachment.detail ? { detail: attachment.detail } : {}),
      })),
    };

    this.appendTimelineEvent(event);
  }

  recordTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    const publication = this.prepareTaskSummaryPublication(clientId, input, this.nowIso());
    if (this.currentSession?.id === publication.event.sessionId && this.currentSession.sessionPath === publication.event.sessionPath) {
      this.currentSession.addEntry(publication.event);
    }
    void this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(publication.event));
    if (publication.callbackData && this.onTaskSummaryIndexedCallback) {
      this.enqueueBackgroundTask(async () => {
        await this.onTaskSummaryIndexedCallback?.(publication.callbackData!);
      });
    }
  }

  queueTaskSummary(clientId: string, input: TaskSummaryRecordInput): void {
    const publication = this.prepareTaskSummaryPublication(clientId, input, this.nowIso());
    if (this.currentSession?.id === publication.event.sessionId && this.currentSession.sessionPath === publication.event.sessionPath) {
      this.currentSession.addEntry(publication.event);
    }
    this.enqueueBackgroundTask(async () => {
      await this.publishPreparedTaskSummary(publication, { addToCurrentSession: false });
    });
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
      summary: input.summary,
      responseKind: input.responseKind,
      status: input.status,
      note: input.note,
    };

    this.appendTimelineEvent(event);
    this.systemEventStore.recordOutcome({
      runId: input.runId,
      eventId: input.eventId,
      status: input.status,
      processedAt: nowIso,
      responseKind: input.responseKind,
      approvalState: input.approvalState,
      note: input.note,
    });
  }

  recordAssistantNotification(clientId: string, input: AssistantNotificationRecordInput): void {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);

    const event: AssistantNotificationEvent = {
      v: 2,
      ts: nowIso,
      type: "assistant_notification",
      sessionId: session.id,
      sessionPath: session.sessionPath,
      message: input.message,
      source: input.source,
      event: input.event,
      eventId: input.eventId,
    };

    this.appendTimelineEvent(event);
  }

  private prepareTaskSummaryPublication(
    clientId: string,
    input: TaskSummaryRecordInput,
    timestamp: string,
  ): PreparedTaskSummaryPublication {
    const sessionPath = this.resolveTaskSummarySessionPath(clientId, input.sessionId, timestamp);
    const event: TaskSummaryEvent = {
      v: 2,
      ts: timestamp,
      type: "task_summary",
      sessionId: input.sessionId,
      sessionPath,
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
      workMode: input.workMode,
      userMessage: input.userMessage,
      assistantResponse: input.assistantResponse,
      approach: input.approach,
      sessionContextSummary: input.sessionContextSummary,
      dependentTaskRunId: input.dependentTaskRunId,
      assistantResponseKind: input.assistantResponseKind,
      feedbackKind: input.feedbackKind,
      feedbackLabel: input.feedbackLabel,
      actionType: input.actionType,
      entityHints: input.entityHints,
      goalDoneWhen: input.goalDoneWhen,
      goalRequiredEvidence: input.goalRequiredEvidence,
      nextAction: input.nextAction,
      stopReason: input.stopReason,
      attachmentNames: input.attachmentNames,
    };

    return {
      event,
      callbackData: this.buildTaskSummaryIndexData(clientId, input, sessionPath, timestamp),
    };
  }

  private resolveTaskSummarySessionPath(clientId: string, sessionId: string, nowIso: string): string {
    if (this.currentSession?.id === sessionId) {
      return this.currentSession.sessionPath;
    }

    const persistedPath = this.persistence.getSessionRelativePath(sessionId);
    if (persistedPath) {
      return persistedPath;
    }

    return this.ensureWritableSession(clientId, nowIso).sessionPath;
  }

  private buildTaskSummaryIndexData(
    clientId: string,
    input: TaskSummaryRecordInput,
    sessionPath: string,
    timestamp: string,
  ): TaskSummaryIndexData | null {
    if (!this.onTaskSummaryIndexedCallback || input.summary.trim().length === 0) {
      return null;
    }

    return {
      clientId,
      sessionId: input.sessionId,
      sessionPath,
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
      workMode: input.workMode,
      userMessage: input.userMessage,
      assistantResponse: input.assistantResponse,
      approach: input.approach,
      sessionContextSummary: input.sessionContextSummary,
      dependentTaskRunId: input.dependentTaskRunId,
      assistantResponseKind: input.assistantResponseKind,
      feedbackKind: input.feedbackKind,
      feedbackLabel: input.feedbackLabel,
      actionType: input.actionType,
      entityHints: input.entityHints,
      goalDoneWhen: input.goalDoneWhen,
      goalRequiredEvidence: input.goalRequiredEvidence,
      nextAction: input.nextAction,
      stopReason: input.stopReason,
      attachmentNames: input.attachmentNames,
      timestamp,
    };
  }

  private async publishPreparedTaskSummary(
    publication: PreparedTaskSummaryPublication,
    options?: { addToCurrentSession?: boolean },
  ): Promise<void> {
    if (options?.addToCurrentSession === false) {
      await this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(publication.event));
    } else {
      await this.appendEventToResolvedSession(publication.event);
    }

    if (publication.callbackData && this.onTaskSummaryIndexedCallback) {
      await this.onTaskSummaryIndexedCallback(publication.callbackData);
    }
  }

  getPromptMemoryContext(): PromptMemoryContext {
    const recentRunLedgers = (this.currentSession?.getRecentUniqueRunLedgerEvents(5) ?? []).map((event) => ({
      timestamp: event.ts,
      runId: event.runId,
      runPath: event.runPath,
      state: event.state,
      status: event.status,
      summary: event.summary,
    }));
    const recentTaskSummaries = (this.currentSession?.getRecentTaskSummaryEvents(5) ?? []).map((event) => ({
      timestamp: event.ts,
      runId: event.runId,
      runPath: event.runPath,
      runStatus: event.status,
      taskStatus: event.taskStatus ?? "not_done",
      objective: event.objective,
      summary: event.summary,
      progressSummary: event.progressSummary,
      currentFocus: event.currentFocus,
      completedMilestones: event.completedMilestones ?? [],
      openWork: event.openWork ?? [],
      blockers: event.blockers ?? [],
      keyFacts: event.keyFacts ?? [],
      evidence: event.evidence ?? [],
      userInputNeeded: event.userInputNeeded,
      workMode: event.workMode,
      userMessage: event.userMessage,
      assistantResponse: event.assistantResponse,
      approach: event.approach,
      sessionContextSummary: event.sessionContextSummary,
      dependentTaskRunId: event.dependentTaskRunId,
      assistantResponseKind: event.assistantResponseKind,
      feedbackKind: event.feedbackKind,
      feedbackLabel: event.feedbackLabel,
      actionType: event.actionType,
      entityHints: event.entityHints ?? [],
      goalDoneWhen: event.goalDoneWhen ?? [],
      goalRequiredEvidence: event.goalRequiredEvidence ?? [],
      nextAction: event.nextAction,
      stopReason: event.stopReason,
      attachmentNames: event.attachmentNames ?? [],
    }));

    return {
      conversationTurns: this.currentSession?.getConversationTurns() ?? [],
      previousSessionSummary: this.currentSession?.handoffSummary ?? "",
      activeSessionPath: this.currentSession?.sessionPath ?? "",
      recentRunLedgers,
      recentTaskSummaries,
      activeAttachments: this.currentSession?.getActiveAttachmentRefs(5) ?? [],
      recentSystemActivity: this.currentSession?.getRecentSystemActivity(10) ?? [],
    };
  }

  getActiveAttachmentRecords(): ActiveAttachmentRecord[] {
    return this.currentSession?.getActiveAttachmentRecords(5) ?? [];
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

    return {
      contextPercent,
      turns,
      sessionAgeMinutes,
      startedAt: this.currentSession.startedAt,
      handoffPhase: this.currentSession.handoff.phase,
      pendingRotationReason: this.currentSession.pendingRotationReason,
    };
  }

  async updateSessionLifecycle(clientId: string, input: SessionLifecycleUpdateInput): Promise<void> {
    const nowIso = this.nowIso();
    const session = this.ensureWritableSession(clientId, nowIso);
    if (session.id !== input.sessionId) {
      return;
    }

    const status = this.getSessionStatus();
    if (!status) {
      return;
    }

    if (shouldPrepareSessionHandoff(status.contextPercent)) {
      this.scheduleHandoffPreparation(session, input.timezone ?? null);
    }

    if (shouldRotateSessionForContext(status.contextPercent)) {
      this.finalizeSessionHandoff(session, nowIso, input.timezone ?? null, "context_threshold");
      session.pendingRotationReason = "context_threshold";
    }
  }

  flushBackgroundTasks(): Promise<void> {
    return this.flushAllQueues();
  }

  flushPersistence(): Promise<void> {
    return this.flushPersistenceQueue();
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
      if (restoredFromCandidate) {
        if (restoredFromCandidate.clientId === clientId) {
          return restoredFromCandidate;
        }
        if (source === "marker" || source === "active_row") {
          return this.reassignSessionClient(restoredFromCandidate, clientId);
        }
      }

      if (candidate.sessionPath.endsWith(".jsonl")) {
        const markdownPath = `${candidate.sessionPath.slice(0, -".jsonl".length)}.md`;
        const markdownKey = `${candidate.sessionId}:${markdownPath}`;
        if (!attempted.has(markdownKey)) {
          attempted.add(markdownKey);
          const restoredFromMarkdown = this.persistence.replaySessionFile(
            this.persistence.resolveSessionAbsolutePath(markdownPath),
          );
          if (restoredFromMarkdown) {
            if (restoredFromMarkdown.clientId === clientId) {
              return restoredFromMarkdown;
            }
            if (source === "marker" || source === "active_row") {
              return this.reassignSessionClient(restoredFromMarkdown, clientId);
            }
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
    this.currentSession = new InMemorySession(
      sessionId,
      clientId,
      nowIso,
      sessionPath,
      options?.parentSessionId,
    );
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

    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(openEvent));
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

    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(closeEvent));
    this.persistence.clearActiveSessionMarker();

    if (this.onSessionCloseCallback && turns.length >= MIN_TURNS_FOR_CALLBACK) {
      const cb = this.onSessionCloseCallback;
        const cbData: SessionCloseData = {
          sessionId: session.id,
          clientId: session.clientId,
          turns,
          reason,
          handoffSummary: options?.handoffSummary ?? null,
        };
      this.enqueueBackgroundTask(async () => {
        await cb(cbData);
      });
    }
  }

  private appendTimelineEvent(event: TimelineEvent): void {
    if (!this.currentSession) return;

    this.currentSession.addEntry(event);
    this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(event));
  }

  private async appendEventToResolvedSession(event: TimelineEvent): Promise<void> {
    if (this.currentSession?.id === event.sessionId && this.currentSession.sessionPath === event.sessionPath) {
      this.currentSession.addEntry(event);
    }

    await this.enqueuePersistenceTask(() => this.persistence.appendEventAsync(event));
  }

  private estimateDynamicTokens(session: InMemorySession): number {
    const turns = session.getConversationTurns();
    const conversationText = turns
      .map((turn) => formatConversationTurnInline(turn))
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

    const activityText = session
      .getRecentSystemActivity(10)
      .map((item) => `${item.source}/${item.event} ${item.summary} ${item.note ?? ""}`)
      .join("\n");

    const estimate =
      this.staticTokenBudget +
      estimateTextTokens(conversationText) +
      estimateTextTokens(activityText) +
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

  private enqueuePersistenceTask(task: () => Promise<void>): Promise<void> {
    this.persistenceQueue = this.persistenceQueue
      .then(task)
      .catch((err) => devWarn("Session persistence task failed:", err instanceof Error ? err.message : String(err)));
    return this.persistenceQueue;
  }

  private async flushPersistenceQueue(): Promise<void> {
    while (true) {
      const current = this.persistenceQueue;
      try {
        await current;
      } catch (err) {
        devWarn("Session persistence task failed while flushing:", err instanceof Error ? err.message : String(err));
      }
      if (current === this.persistenceQueue) {
        return;
      }
    }
  }

  private async flushAllQueues(): Promise<void> {
    while (true) {
      const currentBackground = this.backgroundQueue;
      try {
        await currentBackground;
      } catch (err) {
        devWarn("Background memory task failed while flushing:", err instanceof Error ? err.message : String(err));
      }

      await this.flushPersistenceQueue();

      if (currentBackground === this.backgroundQueue) {
        return;
      }
    }
  }

  private scheduleHandoffPreparation(session: InMemorySession, timezone: string | null): void {
    session.handoff.requestedRevision = Math.max(session.handoff.requestedRevision, session.timeline.length);
    if (session.handoff.phase !== "finalized") {
      session.handoff.phase = "preparing";
    }
    if (session.handoff.jobScheduled) {
      return;
    }

    session.handoff.jobScheduled = true;
    this.enqueueBackgroundTask(async () => {
      try {
        while (this.currentSession?.id === session.id && session.handoff.phase !== "finalized") {
          const artifact = buildSessionHandoff(session, {
            timezone: resolveRotationTimezone(timezone),
            reason: session.pendingRotationReason,
            preparedAt: this.nowIso(),
          });

          if (this.currentSession?.id !== session.id) {
            return;
          }

          session.handoff.artifact = artifact;
          session.handoff.preparedRevision = artifact.revision;
          session.handoff.preparedAt = artifact.preparedAt;
          session.handoff.phase = "ready";

          if (session.handoff.requestedRevision <= session.handoff.preparedRevision) {
            return;
          }
        }
      } finally {
        session.handoff.jobScheduled = false;
        if (
          this.currentSession?.id === session.id &&
          session.handoff.phase !== "finalized" &&
          session.handoff.requestedRevision > session.handoff.preparedRevision
        ) {
          this.scheduleHandoffPreparation(session, timezone);
        }
      }
    });
  }

  private finalizeSessionHandoff(
    session: InMemorySession,
    nowIso: string,
    timezone: string | null,
    reason: SessionRotationReason | null,
  ) {
    const artifact = buildSessionHandoff(session, {
      timezone: resolveRotationTimezone(timezone),
      reason,
      preparedAt: nowIso,
    });
    session.handoff.artifact = artifact;
    session.handoff.preparedRevision = artifact.revision;
    session.handoff.requestedRevision = artifact.revision;
    session.handoff.preparedAt = artifact.preparedAt;
    session.handoff.phase = "finalized";
    session.pendingRotationReason = reason;
    return artifact;
  }

  private normalizeRotationReason(reason: string): SessionRotationReason | null {
    const normalized = reason.trim().toLowerCase();
    if (normalized === "daily_cutover") {
      return "daily_cutover";
    }
    if (normalized === "context_threshold") {
      return "context_threshold";
    }
    return null;
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
      session.parentSessionId,
    );
    migrated.handoffSummary = session.handoffSummary;
    migrated.pendingRotationReason = session.pendingRotationReason;
    migrated.handoff = { ...session.handoff, jobScheduled: false };

    this.persistence.appendEvent({
      v: 2,
      ts: session.startedAt,
      type: "session_open",
      sessionId: session.id,
      sessionPath: markdownSessionPath,
      clientId: session.clientId,
      parentSessionId: session.parentSessionId ?? undefined,
      handoffSummary: session.handoffSummary ?? undefined,
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

  private reassignSessionClient(session: InMemorySession, clientId: string): InMemorySession {
    if (session.clientId === clientId) {
      return session;
    }

    const reassigned = new InMemorySession(
      session.id,
      clientId,
      session.startedAt,
      session.sessionPath,
      session.parentSessionId,
    );
    reassigned.handoffSummary = session.handoffSummary;
    reassigned.pendingRotationReason = session.pendingRotationReason;
    reassigned.handoff = { ...session.handoff, jobScheduled: false };
    for (const entry of session.timeline) {
      reassigned.addEntry(entry);
    }
    return reassigned;
  }
}

export type SessionManagerOptions = MemoryManagerOptions;
export { MemoryManager as SessionManager };
