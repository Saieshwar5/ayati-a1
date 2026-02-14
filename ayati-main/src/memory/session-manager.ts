import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmProvider } from "../core/contracts/provider.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devWarn } from "../shared/index.js";
import type {
  SessionMemory,
  MemoryRunHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  PromptMemoryContext,
  ConversationTurn,
  SessionProfile,
  SessionSummarySearchHit,
} from "./types.js";
import type {
  SessionEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  RunFailureEvent,
  AgentStepEvent,
  AssistantFeedbackEvent,
  ToolContextEntry,
} from "./session-events.js";
import { InMemorySession } from "./session.js";
import { SessionPersistence } from "./session-persistence.js";
import type { SessionPersistenceOptions } from "./session-persistence.js";
import { SqliteMemoryIndex } from "./sqlite-memory-index.js";
import { SessionSummaryService } from "./session-summary-service.js";
import { SessionDriftService } from "./session-drift-service.js";

const MIN_TURNS_FOR_CALLBACK = 2;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 100_000;
const DEFAULT_CHECKPOINT_EXCHANGES = 6;
const DEFAULT_DRIFT_CONFIDENCE_THRESHOLD = 0.65;

export interface SessionCloseData {
  sessionId: string;
  clientId: string;
  turns: ConversationTurn[];
  reason: string;
  profile?: SessionProfile | null;
}

export interface SessionManagerOptions extends SessionPersistenceOptions {
  now?: () => Date;
  provider?: LlmProvider;
  onSessionClose?: (data: SessionCloseData) => void | Promise<void>;
  contextTokenLimit?: number;
  checkpointExchanges?: number;
  driftConfidenceThreshold?: number;
}

export class SessionManager implements SessionMemory {
  private readonly persistence: SessionPersistence;
  private readonly memoryIndex: SqliteMemoryIndex;
  private readonly summaryService: SessionSummaryService;
  private readonly driftService: SessionDriftService;
  private readonly nowProvider: () => Date;
  private readonly onSessionCloseCallback?: (data: SessionCloseData) => void | Promise<void>;
  private readonly contextTokenLimit: number;
  private readonly checkpointExchanges: number;
  private readonly driftConfidenceThreshold: number;

  private currentSession: InMemorySession | null = null;
  private currentSessionProfile: SessionProfile | null = null;
  private previousSessionSummary = "";
  private staticTokenBudget = 0;
  private completedExchangesInSession = 0;
  private lastCheckpointExchange = 0;
  private activeClientId = "";
  private backgroundQueue: Promise<void> = Promise.resolve();

  constructor(options?: SessionManagerOptions) {
    this.persistence = new SessionPersistence({
      dataDir: options?.dataDir,
    });
    this.memoryIndex = new SqliteMemoryIndex({
      dataDir: options?.dataDir,
      dbPath: options?.dbPath,
    });
    this.summaryService = new SessionSummaryService({
      provider: options?.provider,
    });
    this.driftService = new SessionDriftService({
      provider: options?.provider,
    });
    this.nowProvider = options?.now ?? (() => new Date());
    this.onSessionCloseCallback = options?.onSessionClose;
    this.contextTokenLimit = options?.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
    this.checkpointExchanges = Math.max(1, options?.checkpointExchanges ?? DEFAULT_CHECKPOINT_EXCHANGES);
    this.driftConfidenceThreshold =
      options?.driftConfidenceThreshold ?? DEFAULT_DRIFT_CONFIDENCE_THRESHOLD;
  }

  initialize(clientId: string): void {
    this.activeClientId = clientId;
    this.persistence.start();
    this.memoryIndex.start();
    this.removeLegacyInfiniteContextStorage();

    const latest = this.memoryIndex.getLatestSummary(clientId);
    this.previousSessionSummary = latest?.summaryText ?? "";

    const activeId = this.persistence.getActiveSessionId();
    if (activeId) {
      const filePath = resolve(this.persistence.sessionsDir, `${activeId}.jsonl`);
      const restored = this.persistence.replaySessionFile(filePath);
      if (restored && restored.clientId === clientId) {
        this.currentSession = restored;
        this.currentSessionProfile = this.memoryIndex.getSessionMetadata(restored.id);
        this.completedExchangesInSession = restored.getExchangeCount();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.currentSession) {
      this.closeSessionInternal(this.currentSession, this.nowIso(), "shutdown");
      this.currentSession = null;
      this.currentSessionProfile = null;
    }

    try {
      await this.backgroundQueue;
    } catch (err) {
      devWarn("Background memory task failed during shutdown:", err instanceof Error ? err.message : String(err));
    }

    this.persistence.stop();
    this.memoryIndex.stop();
  }

  beginRun(clientId: string, userMessage: string): MemoryRunHandle {
    const nowIso = this.nowIso();
    this.ensureOpenSession(clientId, nowIso);

    if (
      this.currentSession &&
      this.staticTokenBudget + this.estimateDynamicTokens(this.currentSession) >= this.contextTokenLimit
    ) {
      this.rotateSession(clientId, nowIso, "token_limit");
    }

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

    return { sessionId: session.id, runId };
  }

  recordToolCall(_clientId: string, input: ToolCallRecordInput): void {
    if (!this.currentSession || this.currentSession.id !== input.sessionId) return;

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
  }

  recordToolResult(_clientId: string, input: ToolCallResultRecordInput): void {
    if (!this.currentSession || this.currentSession.id !== input.sessionId) return;

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
  }

  recordAssistantFinal(_clientId: string, runId: string, sessionId: string, content: string): void {
    if (!this.currentSession || this.currentSession.id !== sessionId) return;

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

    this.completedExchangesInSession = this.currentSession.getExchangeCount();

    const totalEstimate = this.staticTokenBudget + this.estimateDynamicTokens(this.currentSession);
    if (totalEstimate >= this.contextTokenLimit) {
      this.rotateSession(this.currentSession.clientId, nowIso, "token_limit");
      return;
    }

    const currentSessionId = this.currentSession.id;
    if (this.shouldRunCheckpoint()) {
      const scheduledAtExchange = this.completedExchangesInSession;
      this.lastCheckpointExchange = scheduledAtExchange;
      this.enqueueBackgroundTask(async () => {
        await this.runCheckpointEvaluation(currentSessionId, scheduledAtExchange);
      });
    }
  }

  recordRunFailure(_clientId: string, runId: string, sessionId: string, message: string): void {
    if (!this.currentSession || this.currentSession.id !== sessionId) return;

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

  recordAgentStep(_clientId: string, input: AgentStepRecordInput): void {
    if (!this.currentSession || this.currentSession.id !== input.sessionId) return;

    const nowIso = this.nowIso();
    const event: AgentStepEvent = {
      v: 1,
      ts: nowIso,
      type: "agent_step",
      sessionId: input.sessionId,
      runId: input.runId,
      step: input.step,
      phase: input.phase,
      summary: input.summary,
      approachesTried: input.approachesTried,
      actionToolName: input.actionToolName,
      endStatus: input.endStatus,
    };

    this.currentSession.addEntry(event);
    this.persistence.appendEvent(event);
  }

  recordAssistantFeedback(_clientId: string, runId: string, sessionId: string, message: string): void {
    if (!this.currentSession || this.currentSession.id !== sessionId) return;

    const nowIso = this.nowIso();
    const event: AssistantFeedbackEvent = {
      v: 1,
      ts: nowIso,
      type: "assistant_feedback",
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
        previousSessionSummary: this.previousSessionSummary,
        toolEvents: [],
        activeTopicLabel: undefined,
      };
    }

    return {
      conversationTurns: this.currentSession.getConversationTurns(),
      previousSessionSummary: this.previousSessionSummary,
      toolEvents: this.currentSession.getToolEvents(),
      activeTopicLabel: this.currentSessionProfile?.title,
    };
  }

  setStaticTokenBudget(tokens: number): void {
    this.staticTokenBudget = tokens;
  }

  searchSessionSummaries(query: string, limit = 5): SessionSummarySearchHit[] {
    if (this.activeClientId.trim().length === 0) return [];
    return this.memoryIndex.searchSummaries(this.activeClientId, query, limit);
  }

  loadSessionTurns(sessionId: string): ConversationTurn[] {
    return this.persistence.loadSessionTurns(sessionId);
  }

  flushBackgroundTasks(): Promise<void> {
    return this.backgroundQueue;
  }

  private shouldRunCheckpoint(): boolean {
    if (!this.currentSession) return false;
    if (this.completedExchangesInSession < this.checkpointExchanges) return false;
    if (this.completedExchangesInSession === this.lastCheckpointExchange) return false;
    return this.completedExchangesInSession % this.checkpointExchanges === 0;
  }

  private async runCheckpointEvaluation(sessionId: string, scheduledExchangeCount: number): Promise<void> {
    const session = this.currentSession;
    if (!session || session.id !== sessionId) return;
    if (this.completedExchangesInSession < scheduledExchangeCount) return;

    const turns = session
      .getConversationTurns()
      .slice(-Math.max(6, this.checkpointExchanges * 2));
    if (turns.length < this.checkpointExchanges * 2) return;

    const nowIso = this.nowIso();

    if (!this.currentSessionProfile) {
      const bootstrap = await this.driftService.buildSessionProfile(turns, nowIso);
      if (!bootstrap) return;
      if (!this.currentSession || this.currentSession.id !== sessionId) return;
      this.currentSessionProfile = bootstrap;
      this.memoryIndex.upsertSessionMetadata(sessionId, bootstrap);
      return;
    }

    const result = await this.driftService.evaluateCheckpoint(this.currentSessionProfile, turns, nowIso);
    if (!this.currentSession || this.currentSession.id !== sessionId) return;

    if (result.decision.isDrift && result.decision.confidence >= this.driftConfidenceThreshold) {
      this.rotateSession(this.currentSession.clientId, this.nowIso(), "topic_drift", result.decision.confidence);
      return;
    }

    if (result.updatedProfile) {
      this.currentSessionProfile = result.updatedProfile;
      this.memoryIndex.upsertSessionMetadata(sessionId, result.updatedProfile);
    }
  }

  private ensureOpenSession(clientId: string, nowIso: string): void {
    if (this.currentSession) return;
    this.createNewSession(clientId, nowIso);
  }

  private createNewSession(clientId: string, nowIso: string): void {
    const sessionId = randomUUID();
    this.currentSession = new InMemorySession(sessionId, clientId, nowIso);
    this.currentSessionProfile = null;
    this.completedExchangesInSession = 0;
    this.lastCheckpointExchange = 0;

    const openEvent: SessionEvent = {
      v: 1,
      ts: nowIso,
      type: "session_open",
      sessionId,
      clientId,
      previousSessionSummary: this.previousSessionSummary,
    };

    this.persistence.appendEvent(openEvent);
    this.persistence.writeActiveSessionMarker(sessionId);
  }

  private rotateSession(clientId: string, nowIso: string, reason: string, driftScore?: number): void {
    if (!this.currentSession) {
      this.createNewSession(clientId, nowIso);
      return;
    }

    const closing = this.currentSession;
    const profile = this.currentSessionProfile;
    this.closeSessionInternal(closing, nowIso, reason, profile, driftScore);
    this.currentSession = null;
    this.currentSessionProfile = null;
    this.createNewSession(clientId, nowIso);
  }

  private closeSessionInternal(
    session: InMemorySession,
    nowIso: string,
    reason: string,
    profile: SessionProfile | null = null,
    driftScore?: number,
  ): void {
    const turns = session.getConversationTurns();
    const tokenAtClose = this.estimateDynamicTokens(session);

    const baselineSummary = this.summaryService.summarizeSessionSync(turns);
    this.persistSessionSummary({
      sessionId: session.id,
      clientId: session.clientId,
      createdAt: session.startedAt,
      closedAt: nowIso,
      closeReason: reason,
      tokenCount: tokenAtClose,
      sourcePath: this.persistence.getSessionFilePath(session.id),
      record: baselineSummary,
    });
    this.previousSessionSummary = baselineSummary.summaryText;

    const closeEvent: SessionEvent = {
      v: 1,
      ts: nowIso,
      type: "session_close",
      sessionId: session.id,
      reason,
      summaryText: baselineSummary.summaryText,
      summaryKeywords: baselineSummary.keywords,
      tokenAtClose,
      driftScore,
    };

    this.persistence.appendEvent(closeEvent);
    this.persistence.clearActiveSessionMarker();

    if (profile) {
      this.memoryIndex.upsertSessionMetadata(session.id, profile);
    }

    if (this.onSessionCloseCallback && turns.length >= MIN_TURNS_FOR_CALLBACK) {
      const cb = this.onSessionCloseCallback;
      const cbData: SessionCloseData = {
        sessionId: session.id,
        clientId: session.clientId,
        turns,
        reason,
        profile,
      };
      this.enqueueBackgroundTask(async () => {
        await cb(cbData);
      });
    }

    if (this.summaryService.hasLlmSupport() && turns.length > 0) {
      this.enqueueBackgroundTask(async () => {
        const refined = await this.summaryService.summarizeSession(turns, reason, profile);
        this.persistSessionSummary({
          sessionId: session.id,
          clientId: session.clientId,
          createdAt: session.startedAt,
          closedAt: nowIso,
          closeReason: reason,
          tokenCount: tokenAtClose,
          sourcePath: this.persistence.getSessionFilePath(session.id),
          record: refined,
        });
        this.previousSessionSummary = refined.summaryText;
      });
    }
  }

  private persistSessionSummary(input: {
    sessionId: string;
    clientId: string;
    createdAt: string;
    closedAt: string;
    closeReason: string;
    tokenCount: number;
    sourcePath: string;
    record: {
      summaryText: string;
      keywords: string[];
      confidence: number;
      redactionFlags: string[];
    };
  }): void {
    try {
      this.memoryIndex.upsertSessionSummary({
        sessionId: input.sessionId,
        clientId: input.clientId,
        createdAt: input.createdAt,
        closedAt: input.closedAt,
        closeReason: input.closeReason,
        tokenCount: input.tokenCount,
        sourcePath: input.sourcePath,
        record: input.record,
      });
    } catch (err) {
      devWarn("Failed to persist session summary:", err instanceof Error ? err.message : String(err));
    }
  }

  private estimateDynamicTokens(session: InMemorySession): number {
    const turns = session.getConversationTurns();
    const conversationText = turns
      .map((turn) => turn.content)
      .join("\n");
    const profileText = this.currentSessionProfile
      ? [
          this.currentSessionProfile.title,
          this.currentSessionProfile.scope,
          this.currentSessionProfile.keywords.join(" "),
          this.currentSessionProfile.anchors.join(" "),
        ].join("\n")
      : "";

    return (
      estimateTextTokens(this.previousSessionSummary) +
      estimateTextTokens(conversationText) +
      estimateTextTokens(profileText) +
      session.estimateToolEventTokens()
    );
  }

  private enqueueBackgroundTask(task: () => Promise<void>): void {
    this.backgroundQueue = this.backgroundQueue
      .then(task)
      .catch((err) => devWarn("Background memory task failed:", err instanceof Error ? err.message : String(err)));
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
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
}
