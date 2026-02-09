import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { devLog, devWarn } from "../shared/index.js";
import type {
  SessionMemory,
  MemoryRunHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  PromptMemoryContext,
} from "./types.js";
import type {
  SessionEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  SessionTierChangeEvent,
  ToolContextEntry,
} from "./session-events.js";
import { InMemorySession } from "./session.js";
import { SessionPersistence } from "./session-persistence.js";
import type { SessionPersistenceOptions } from "./session-persistence.js";
import {
  shouldCloseSession,
  computeActivityScoreFromTimeline,
  refreshTier,
} from "./tiering.js";
import { generateSummary } from "./summary.js";

const ROLLING_SUMMARY_EVERY_USER_TURNS = 12;

export interface SessionManagerOptions extends SessionPersistenceOptions {
  now?: () => Date;
}

export class SessionManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly nowProvider: () => Date;
  private currentSession: InMemorySession | null = null;
  private previousSessionSummary = "";

  constructor(options?: SessionManagerOptions) {
    this.persistence = new SessionPersistence({
      dbPath: options?.dbPath,
      dataDir: options?.dataDir,
    });
    this.nowProvider = options?.now ?? (() => new Date());
  }

  initialize(clientId: string): void {
    this.persistence.start();
    this.previousSessionSummary = this.persistence.loadPreviousSessionSummary(clientId);

    const activeId = this.persistence.getActiveSessionId();
    if (activeId) {
      devLog(`Found active session marker for ${activeId} — replaying`);
      const filePath = resolve(this.persistence.sessionsDir, `${activeId}.jsonl`);
      const restored = this.persistence.replaySessionFile(filePath);
      if (restored && restored.clientId === clientId) {
        const nowIso = this.nowIso();
        if (
          shouldCloseSession(
            {
              startedAt: restored.startedAt,
              lastActivityAt: restored.lastActivityAt,
              hardCapMinutes: restored.tierState.hardCapMinutes,
              idleTimeoutMinutes: restored.tierState.idleTimeoutMinutes,
            },
            nowIso,
          )
        ) {
          this.closeSessionInternal(restored, nowIso, "expired_on_recovery");
        } else {
          this.currentSession = restored;
          devLog(`Restored session ${restored.id} with ${restored.timeline.length} events`);
        }
      }
    }
  }

  shutdown(): void {
    if (this.currentSession) {
      this.closeSessionInternal(this.currentSession, this.nowIso(), "shutdown");
      this.currentSession = null;
    }
    this.persistence.stop();
  }

  beginRun(clientId: string, userMessage: string): MemoryRunHandle {
    const nowIso = this.nowIso();
    this.ensureOpenSession(clientId, nowIso);

    const session = this.currentSession!;
    const runId = randomUUID();

    const event: UserMessageEvent = {
      v: 1,
      ts: nowIso,
      type: "user_message",
      sessionId: session.id,
      runId,
      content: userMessage,
    };

    session.addEntry(event);
    this.persistence.appendEvent(event);
    this.refreshCurrentTier(nowIso);

    return { sessionId: session.id, runId };
  }

  recordToolCall(_clientId: string, input: ToolCallRecordInput): void {
    if (!this.currentSession) return;

    const nowIso = this.nowIso();
    const event: ToolCallEvent = {
      v: 1,
      ts: nowIso,
      type: "tool_call",
      sessionId: input.sessionId,
      runId: input.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
    };

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);
    this.refreshCurrentTier(nowIso);
  }

  recordToolResult(_clientId: string, input: ToolCallResultRecordInput): void {
    if (!this.currentSession) return;

    const nowIso = this.nowIso();
    const output = input.output ?? "";

    this.persistence.persistLargeToolOutput(
      input.sessionId,
      input.toolCallId,
      input.toolName,
      output,
    );

    const event: ToolResultEvent = {
      v: 1,
      ts: nowIso,
      type: "tool_result",
      sessionId: input.sessionId,
      runId: input.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: input.status,
      output,
      errorMessage: input.errorMessage,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
    };

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);

    const toolContextEntry: ToolContextEntry = {
      v: 1,
      ts: nowIso,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      args: this.currentSession.findToolCallRawArgs(input.toolCallId),
      status: input.status,
      output,
      errorMessage: input.errorMessage,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
    };
    this.persistence.appendToolContextEntry(input.toolName, toolContextEntry);

    this.refreshCurrentTier(nowIso);
  }

  recordAssistantFinal(_clientId: string, runId: string, sessionId: string, content: string): void {
    if (!this.currentSession) return;

    const nowIso = this.nowIso();
    const event: AssistantMessageEvent = {
      v: 1,
      ts: nowIso,
      type: "assistant_message",
      sessionId,
      runId,
      content,
    };

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);
    this.refreshCurrentTier(nowIso);
    this.maybeCreateRollingSummary(nowIso);
  }

  recordRunFailure(_clientId: string, runId: string, sessionId: string, message: string): void {
    if (!this.currentSession) return;

    const nowIso = this.nowIso();
    const event: RunFailureEvent = {
      v: 1,
      ts: nowIso,
      type: "run_failure",
      sessionId,
      runId,
      message,
    };

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);
  }

  getPromptMemoryContext(): PromptMemoryContext {
    if (!this.currentSession) {
      return {
        conversationTurns: [],
        previousSessionSummary: "",
        toolEvents: [],
      };
    }

    return {
      conversationTurns: this.currentSession.getConversationTurns(),
      previousSessionSummary: this.previousSessionSummary,
      toolEvents: this.currentSession.getToolEvents(),
    };
  }

  private ensureOpenSession(clientId: string, nowIso: string): void {
    if (this.currentSession) {
      if (
        shouldCloseSession(
          {
            startedAt: this.currentSession.startedAt,
            lastActivityAt: this.currentSession.lastActivityAt,
            hardCapMinutes: this.currentSession.tierState.hardCapMinutes,
            idleTimeoutMinutes: this.currentSession.tierState.idleTimeoutMinutes,
          },
          nowIso,
        )
      ) {
        this.closeSessionInternal(this.currentSession, nowIso, "expired");
      } else {
        return;
      }
    }

    this.createNewSession(clientId, nowIso);
  }

  private createNewSession(clientId: string, nowIso: string): void {
    const sessionId = randomUUID();
    this.currentSession = new InMemorySession(sessionId, clientId, nowIso, "rare");

    const openEvent: SessionEvent = {
      v: 1,
      ts: nowIso,
      type: "session_open",
      sessionId,
      clientId,
      tier: "rare",
      hardCapMinutes: this.currentSession.tierState.hardCapMinutes,
      idleTimeoutMinutes: this.currentSession.tierState.idleTimeoutMinutes,
      previousSessionSummary: this.previousSessionSummary,
    };

    this.persistence.appendEvent(openEvent);
    this.persistence.writeActiveSessionMarker(sessionId);
    devLog(`Created new session ${sessionId}`);
  }

  private closeSessionInternal(session: InMemorySession, nowIso: string, reason: string): void {
    const summaryText = generateSummary(session, "final");

    const closeEvent: SessionEvent = {
      v: 1,
      ts: nowIso,
      type: "session_close",
      sessionId: session.id,
      reason,
      summaryText,
    };

    this.persistence.appendEvent(closeEvent);
    this.persistence.clearActiveSessionMarker();

    const keywords = this.extractKeywords(session);
    this.persistence.saveSessionSummary(
      session.id,
      session.clientId,
      "final",
      summaryText,
      keywords,
      nowIso,
    );

    this.previousSessionSummary = summaryText;
    devLog(`Closed session ${session.id} (reason: ${reason})`);
  }

  private refreshCurrentTier(nowIso: string): void {
    if (!this.currentSession) return;

    const timeline = this.currentSession.getTimelineForScoring();
    const score = computeActivityScoreFromTimeline(timeline, nowIso);
    const result = refreshTier(this.currentSession.tierState, score);

    if (result.changed) {
      const fromTier = this.currentSession.tierState.tier;
      this.currentSession.tierState = result.newState;

      const event: SessionTierChangeEvent = {
        v: 1,
        ts: nowIso,
        type: "session_tier_change",
        sessionId: this.currentSession.id,
        fromTier,
        toTier: result.newState.tier,
        score,
        hardCapMinutes: result.newState.hardCapMinutes,
        idleTimeoutMinutes: result.newState.idleTimeoutMinutes,
      };

      this.currentSession.addEntry(event);
      this.persistence.appendEvent(event);
    } else {
      this.currentSession.tierState = result.newState;
    }
  }

  private maybeCreateRollingSummary(nowIso: string): void {
    if (!this.currentSession) return;

    const userTurns = this.currentSession.userTurnCount;
    if (userTurns === 0 || userTurns % ROLLING_SUMMARY_EVERY_USER_TURNS !== 0) return;

    const summaryText = generateSummary(this.currentSession, "rolling");
    const keywords = this.extractKeywords(this.currentSession);

    this.persistence.saveSessionSummary(
      this.currentSession.id,
      this.currentSession.clientId,
      "rolling",
      summaryText,
      keywords,
      nowIso,
    );
  }

  private extractKeywords(session: InMemorySession): string[] {
    const turns = session.getConversationTurns();
    const userTopics = turns
      .filter((t) => t.role === "user")
      .map((t) => t.content)
      .join(" ");

    const toolNames = [...new Set(session.getToolEvents().map((e) => e.toolName))];

    const terms = userTopics
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);

    const unique = new Set<string>();
    for (const term of terms) {
      if (unique.size >= 12) break;
      unique.add(term);
    }

    return [...new Set([...unique, ...toolNames])];
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}
