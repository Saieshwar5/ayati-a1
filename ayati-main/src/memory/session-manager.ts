import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devWarn } from "../shared/index.js";
import type {
  SessionMemory,
  MemoryRunHandle,
  TurnStatusRecordInput,
  CreateSessionInput,
  CreateSessionResult,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  PromptMemoryContext,
  ConversationTurn,
} from "./types.js";
import type {
  SessionEvent,
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
import { InMemorySession } from "./session.js";
import { SessionPersistence } from "./session-persistence.js";
import type { ActiveSessionInfo, SessionPersistenceOptions } from "./session-persistence.js";

const MIN_TURNS_FOR_CALLBACK = 2;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 100_000;
const PROMPT_EVENT_WINDOW = 20;
const PROMPT_AGENT_STEP_WINDOW = 10;

export interface SessionCloseData {
  sessionId: string;
  clientId: string;
  turns: ConversationTurn[];
  reason: string;
}

export interface MemoryManagerOptions extends SessionPersistenceOptions {
  now?: () => Date;
  onSessionClose?: (data: SessionCloseData) => void | Promise<void>;
  contextTokenLimit?: number;
}

type TimelineEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | TurnStatusEvent
  | ToolCallEvent
  | ToolResultEvent
  | RunFailureEvent
  | AgentStepEvent
  | AssistantFeedbackEvent;

export class MemoryManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly nowProvider: () => Date;
  private readonly onSessionCloseCallback?: (data: SessionCloseData) => void | Promise<void>;
  private readonly contextTokenLimit: number;

  private currentSession: InMemorySession | null = null;
  private promptWindowEvents: CountableSessionEvent[] = [];
  private promptWindowToolEvents: ToolSessionEvent[] = [];
  private promptWindowAgentStepEvents: AgentStepEvent[] = [];
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
    this.contextTokenLimit = options?.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.removeLegacyInfiniteContextStorage();
    this.restoreActiveSession(clientId);

    if (this.currentSession) {
      // If we resumed an active session, hydrate conversation window from that session timeline.
      this.promptWindowEvents = this.currentSession.getCountableEvents(PROMPT_EVENT_WINDOW);
      return;
    }

    this.promptWindowEvents = this.persistence.loadRecentCountableEvents(clientId, PROMPT_EVENT_WINDOW);
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

    this.appendTimelineEvent(event, true);

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

    this.appendTimelineEvent(event, false);
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
      this.appendTimelineEvent(handoffEvent, false);
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
    this.appendTimelineEvent(event, false);

    return {
      previousSessionId,
      sessionId: active.id,
      sessionPath: active.sessionPath,
    };
  }

  recordToolCall(clientId: string, input: ToolCallRecordInput): void {
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

    this.appendTimelineEvent(event, false);
  }

  recordToolResult(clientId: string, input: ToolCallResultRecordInput): void {
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

    this.appendTimelineEvent(event, false);
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

    this.appendTimelineEvent(event, true);
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

    this.appendTimelineEvent(event, false);
  }

  recordAgentStep(clientId: string, input: AgentStepRecordInput): void {
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

    this.appendTimelineEvent(event, false);
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

    this.appendTimelineEvent(event, false);
  }

  getPromptMemoryContext(): PromptMemoryContext {
    if (this.promptWindowEvents.length === 0) {
      return {
        conversationTurns: [],
        previousSessionSummary: "",
      };
    }

    const promptSession = new InMemorySession(
      this.currentSession?.id ?? "prompt-window",
      this.activeClientId,
      this.nowIso(),
      this.currentSession?.sessionPath ?? "sessions/ephemeral/prompt-window.md",
    );
    for (const event of this.promptWindowEvents) {
      promptSession.addEntry(event);
    }

    return {
      conversationTurns: promptSession.getConversationTurns(PROMPT_EVENT_WINDOW),
      previousSessionSummary: "",
    };
  }

  setStaticTokenBudget(tokens: number): void {
    this.staticTokenBudget = tokens;
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

  private appendTimelineEvent(event: TimelineEvent, countable: boolean): void {
    if (!this.currentSession) return;

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);

    if (event.type === "tool_call" || event.type === "tool_result") {
      this.pushPromptToolWindowEvent(event);
    }

    if (event.type === "agent_step") {
      this.pushPromptAgentStepWindowEvent(event);
    }

    if (countable) {
      this.pushPromptWindowEvent(event as CountableSessionEvent);
    }
  }

  private estimateDynamicTokens(session: InMemorySession): number {
    const turns = session.getConversationTurns(PROMPT_EVENT_WINDOW);
    const conversationText = turns
      .map((turn) => `${turn.role}: ${turn.content}`)
      .join("\n");

    const toolText = session
      .getToolEvents(PROMPT_EVENT_WINDOW)
      .map((event) => {
        const status = event.status ? ` status=${event.status}` : "";
        const error = event.errorMessage ? ` error=${event.errorMessage}` : "";
        return `${event.eventType} ${event.toolName}${status} args=${event.args} output=${event.output}${error}`;
      })
      .join("\n");

    const estimate =
      this.staticTokenBudget +
      estimateTextTokens(conversationText) +
      estimateTextTokens(toolText) +
      session.estimateToolEventTokens(PROMPT_EVENT_WINDOW);

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

  private pushPromptWindowEvent(event: CountableSessionEvent): void {
    this.promptWindowEvents.push(event);
    if (this.promptWindowEvents.length <= PROMPT_EVENT_WINDOW) return;
    this.promptWindowEvents = this.promptWindowEvents.slice(-PROMPT_EVENT_WINDOW);
  }

  private pushPromptToolWindowEvent(event: ToolSessionEvent): void {
    this.promptWindowToolEvents.push(event);
    if (this.promptWindowToolEvents.length <= PROMPT_EVENT_WINDOW) return;
    this.promptWindowToolEvents = this.promptWindowToolEvents.slice(-PROMPT_EVENT_WINDOW);
  }

  private pushPromptAgentStepWindowEvent(event: AgentStepEvent): void {
    this.promptWindowAgentStepEvents.push(event);
    if (this.promptWindowAgentStepEvents.length <= PROMPT_AGENT_STEP_WINDOW) return;
    this.promptWindowAgentStepEvents = this.promptWindowAgentStepEvents.slice(-PROMPT_AGENT_STEP_WINDOW);
  }

  private removeLegacyInfiniteContextStorage(): void {
    const legacyDir = resolve(this.persistence.sessionsDir, "..", "infinite-context");
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch (err) {
      devWarn(
        "Failed to remove legacy infinite-context storage:",
        err instanceof Error ? err.message : String(err),
      );
    }
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
