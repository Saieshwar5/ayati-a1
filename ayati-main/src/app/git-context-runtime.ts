import { createHash } from "node:crypto";
import type {
  AgentRunHandle,
  FinalizeRunResponse,
  GitContextService,
  RunOutcome,
  RunStepRecord,
  RunStopReason,
  RunWorkStateInput,
  TaskCompletionRecord,
  RecordSessionAttachmentsResponse,
} from "ayati-git-context";
import { GitContextObserver } from "ayati-git-context";
import type {
  ContextEngineMachineContext,
  ContextRunStepRecord,
  ContextSessionAttachmentRecord,
} from "../context-engine/index.js";
import { getToolTaxonomy } from "../skills/tool-taxonomy.js";
import { GitContextHarnessCache } from "./git-context-harness-cache.js";

export interface GitContextPreparedTurn {
  status: "ready";
  sessionId: string;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  currentMessageId: string;
  currentMessageSessionSequence: number;
  conversationId: string;
  inputRole: "user" | "system_event";
  run: AgentRunHandle;
  context: ContextEngineMachineContext;
}

export interface GitContextFinalizeRunInput {
  turn: GitContextPreparedTurn | null;
  outcome: RunOutcome;
  stopReason: RunStopReason;
  assistantResponse: string;
  conversationSummary: string;
  summary: string;
  validation: "passed" | "failed" | "not_applicable";
  next?: string;
  workState?: unknown;
  taskCompletion?: TaskCompletionRecord;
  at: string;
}

export interface GitContextRuntimeOptions {
  service: GitContextService;
  timezone: string;
  agentId: string;
  observer?: GitContextObserver;
}

export interface GitContextRuntime {
  warmActiveContext(): Promise<void>;
  prepareUserTurn(input: {
    clientId: string;
    userMessage: string;
    at: string;
  }): Promise<GitContextPreparedTurn>;
  prepareSystemEventTurn(input: {
    clientId: string;
    systemMessage: string;
    at: string;
  }): Promise<GitContextPreparedTurn>;
  finalizeRun(input: GitContextFinalizeRunInput): Promise<FinalizeRunResponse | null>;
  recordRunStep(input: {
    turn: GitContextPreparedTurn | null;
    record: ContextRunStepRecord;
    currentContext?: ContextEngineMachineContext;
    [key: string]: unknown;
  }): Promise<ContextEngineMachineContext | null>;
  recordSessionAttachments(input: {
    turn: GitContextPreparedTurn | null;
    attachments: ContextSessionAttachmentRecord[];
    at: string;
    [key: string]: unknown;
  }): Promise<RecordSessionAttachmentsResponse | null>;
  buildActiveContext(sessionId: string): Promise<ContextEngineMachineContext>;
}

export function createGitContextRuntime(options: GitContextRuntimeOptions): GitContextRuntime {
  return new AppGitContextRuntime(options);
}

class AppGitContextRuntime implements GitContextRuntime {
  private writeChain: Promise<void> = Promise.resolve();
  private readonly contextCache = new GitContextHarnessCache();
  private readonly observer: GitContextObserver;

  constructor(private readonly options: GitContextRuntimeOptions) {
    this.observer = options.observer ?? new GitContextObserver("git-context-harness");
    this.observer.emit({ level: "info", event: "harness_context_cache_created" });
  }

  async warmActiveContext(): Promise<void> {
    const startedAt = Date.now();
    this.observer.emit({ level: "info", event: "harness_context_warm_started" });
    const active = await this.options.service.getActiveContext({});
    const sessionId = active.session?.session.sessionId;
    if (sessionId) this.contextCache.set(sessionId, active);
    this.observer.emit({
      level: "info",
      event: "harness_context_warm_completed",
      ...(sessionId ? { sessionId } : {}),
      durationMs: Date.now() - startedAt,
      data: { contextRevision: active.contextRevision, hasActiveSession: Boolean(sessionId) },
    });
  }

  async prepareUserTurn(input: {
    clientId: string;
    userMessage: string;
    at: string;
  }): Promise<GitContextPreparedTurn> {
    return await this.prepareInput(input.clientId, "user", input.userMessage, input.at);
  }

  async prepareSystemEventTurn(input: {
    clientId: string;
    systemMessage: string;
    at: string;
  }): Promise<GitContextPreparedTurn> {
    return await this.prepareInput(input.clientId, "system_event", input.systemMessage, input.at);
  }

  async finalizeRun(input: GitContextFinalizeRunInput): Promise<FinalizeRunResponse | null> {
    if (!input.turn) return null;
    await this.drainWrites();
    const turn = input.turn;
    this.observer.emit({
      level: "info",
      event: "run_finalization_started",
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      runId: turn.run.runId,
      taskId: turn.context.pendingTurn?.workId,
      data: {
        outcome: input.outcome,
        stopReason: input.stopReason,
        taskBound: turn.context.pendingTurn?.routingStatus === "bound",
      },
    });
    try {
      const response = await this.options.service.finalizeRun({
        requestId: operationRequestId(turn.run.runId, "finalize"),
        sessionId: turn.sessionId,
        runId: turn.run.runId,
        outcome: input.outcome,
        stopReason: input.stopReason,
        assistantResponse: input.assistantResponse,
        conversationSummary: input.conversationSummary,
        summary: input.summary,
        validation: input.validation,
        ...(input.next ? { next: input.next } : {}),
        workState: toRunWorkState(input.workState, input.outcome),
        ...(input.taskCompletion ? { task: { completion: input.taskCompletion } } : {}),
        at: input.at,
      });
      this.contextCache.markDirty(turn.sessionId);
      this.observer.emit({
        level: "info",
        event: "run_finalization_completed",
        sessionId: turn.sessionId,
        seq: turn.messageSeq,
        runId: response.run.runId,
        taskId: response.run.taskBinding?.taskId,
        outcome: "succeeded",
        data: {
          outcome: response.run.status,
          stopReason: response.run.stopReason,
          taskBinding: response.run.taskBinding,
          materialization: response.materialization,
          commit: response.commit,
        },
      });
      if (response.commit.status === "committed") {
        this.observer.emit({
          level: "info",
          event: "task_commit_created",
          sessionId: turn.sessionId,
          seq: turn.messageSeq,
          runId: response.run.runId,
          taskId: response.commit.taskId,
          outcome: "succeeded",
          data: response.commit,
        });
      }
      return response;
    } catch (error) {
      this.contextCache.markDirty(turn.sessionId);
      this.observer.emit({
        level: "error",
        event: "run_finalization_failed",
        sessionId: turn.sessionId,
        seq: turn.messageSeq,
        runId: turn.run.runId,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async recordRunStep(input: {
    turn: GitContextPreparedTurn | null;
    record: ContextRunStepRecord;
    currentContext?: ContextEngineMachineContext;
  }): Promise<ContextEngineMachineContext | null> {
    if (!input.turn) return null;
    const turn = input.turn;
    const record = toRunStepRecord(input.record);
    this.observer.emit({
      level: "debug",
      event: "run_step_persistence_queued",
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      runId: turn.run.runId,
      step: record.step,
      data: { tools: record.toolCalls.map((call) => call.tool) },
    });
    const persisted = this.writeChain.then(async () => {
      try {
        const response = await this.options.service.recordRunStep({
          requestId: operationRequestId(turn.run.runId, "step-" + record.step),
          sessionId: turn.sessionId,
          runId: turn.run.runId,
          record,
        });
        const projection = this.contextCache.updateRun({
          sessionId: turn.sessionId,
          run: response.run,
          readContext: response.readContext,
          ...(input.currentContext ? { baseProjection: input.currentContext } : {}),
        });
        if (projection) turn.context = projection;
        this.observer.emit({
          level: "info",
          event: "run_step_persisted",
          sessionId: turn.sessionId,
          seq: turn.messageSeq,
          runId: turn.run.runId,
          step: record.step,
          outcome: "succeeded",
          data: {
            workStateRevision: response.run.workState.revision,
            afterStep: response.run.workState.afterStep,
          },
        });
        return projection ?? await this.refreshActiveContext(turn.sessionId);
      } catch (error) {
        this.contextCache.markDirty(turn.sessionId);
        this.observer.emit({
          level: "error",
          event: "run_step_persistence_failed",
          sessionId: turn.sessionId,
          seq: turn.messageSeq,
          runId: turn.run.runId,
          step: record.step,
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    this.writeChain = persisted.then(() => undefined);
    return await persisted;
  }

  async recordSessionAttachments(input: {
    turn: GitContextPreparedTurn | null;
    attachments: ContextSessionAttachmentRecord[];
    at: string;
  }): Promise<RecordSessionAttachmentsResponse | null> {
    if (!input.turn || input.attachments.length === 0) return null;
    const response = await this.options.service.recordSessionAttachments({
      requestId: operationRequestId(input.turn.run.runId, "session-attachments"),
      sessionId: input.turn.sessionId,
      conversationId: input.turn.conversationId,
      attachments: input.attachments,
      at: input.at,
    });
    this.contextCache.markDirty(input.turn.sessionId);
    return response;
  }

  async buildActiveContext(sessionId: string): Promise<ContextEngineMachineContext> {
    const cached = this.contextCache.getProjection(sessionId);
    if (cached) {
      this.emitCacheSummary(sessionId, "hit");
      return cached;
    }
    this.emitCacheSummary(sessionId, "miss");
    await this.drainWrites();
    return this.contextCache.getProjection(sessionId)
      ?? this.refreshActiveContext(sessionId);
  }

  private async prepareInput(
    clientId: string,
    role: "user" | "system_event",
    content: string,
    at: string,
  ): Promise<GitContextPreparedTurn> {
    const requestId = preparationRequestId(clientId, role, content, at);
    const prepared = await this.options.service.prepareContextTurn({
      requestId,
      date: localDate(at, this.options.timezone),
      timezone: this.options.timezone,
      agentId: this.options.agentId,
      role,
      content,
      at,
    });
    const context = this.contextCache.set(prepared.session.sessionId, prepared.context);
    const run: AgentRunHandle = {
      runId: prepared.run.runId,
      sessionId: prepared.run.sessionId,
      conversationId: prepared.run.conversationId,
      triggerSeq: prepared.message.sessionSequence,
    };
    this.observer.emit({
      level: "info",
      event: "run_started",
      requestId,
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: run.runId,
      outcome: "succeeded",
      data: { contextRevision: prepared.context.contextRevision },
    });
    return {
      status: "ready",
      sessionId: prepared.session.sessionId,
      repoPath: prepared.session.repositoryPath,
      initialized: prepared.sessionCreated,
      messageSeq: prepared.conversation.sequence,
      currentMessageId: prepared.message.messageId,
      currentMessageSessionSequence: prepared.message.sessionSequence,
      conversationId: prepared.conversation.conversationId,
      inputRole: role,
      run,
      context,
    };
  }

  private async drainWrites(): Promise<void> {
    await this.writeChain;
  }

  private async refreshActiveContext(sessionId: string): Promise<ContextEngineMachineContext> {
    const startedAt = Date.now();
    const previousRevision = this.contextCache.getStats(sessionId).revision;
    const active = await this.options.service.getActiveContext({ sessionId });
    const projection = this.contextCache.set(sessionId, active);
    this.observer.emit({
      level: "info",
      event: "harness_context_refresh_completed",
      sessionId,
      durationMs: Date.now() - startedAt,
      outcome: "succeeded",
      data: {
        previousRevision,
        contextRevision: active.contextRevision,
        readContextRevision: active.readContext?.revision,
        readContextAfterCommitRunId: active.readContext?.afterCommitRunId,
        ...(active.readContext ? {
          readContextCounts: {
            inventory: active.readContext.inventory.length,
            discovery: active.readContext.discovery.length,
            evidence: active.readContext.evidence.length,
            actions: active.readContext.actions.length,
            total: active.readContext.inventory.length
              + active.readContext.discovery.length
              + active.readContext.evidence.length
              + active.readContext.actions.length,
          },
        } : {}),
        ...this.contextCache.getStats(sessionId),
      },
    });
    return projection;
  }

  private emitCacheSummary(sessionId: string, outcome: "hit" | "miss"): void {
    this.observer.emit({
      level: outcome === "hit" ? "debug" : "info",
      event: outcome === "hit" ? "harness_context_cache_hit" : "harness_context_cache_miss",
      sessionId,
      outcome: "succeeded",
      data: { cacheOutcome: outcome, ...this.contextCache.getStats(sessionId) },
    });
  }
}

function toRunStepRecord(record: ContextRunStepRecord): RunStepRecord {
  return {
    version: 1,
    step: record.step,
    status: record.status === "failed"
      ? "failed"
      : record.status === "skipped"
        ? "blocked"
        : "completed",
    summary: record.summary,
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.action ? { action: record.action } : {}),
    toolCalls: record.toolCalls.map((call) => {
      const taxonomy = getToolTaxonomy(call.tool);
      if (!taxonomy) {
        throw new Error("Unknown tool taxonomy for persisted run step: " + call.tool);
      }
      return {
        ...(call.callId ? { callId: call.callId } : {}),
        tool: call.tool,
        purpose: call.purpose?.trim() || "Execute " + call.tool + ".",
        toolPurpose: taxonomy.purpose,
        toolEffect: taxonomy.effect,
        status: call.status,
        input: call.input,
        ...(call.output !== undefined ? { output: call.output } : {}),
        ...(call.error !== undefined ? { error: call.error } : {}),
      };
    }),
    verification: record.verification,
    workStateAfter: toRunWorkState(record.workStateAfter),
    createdAt: record.completedAt,
  };
}

function toRunWorkState(value: unknown, outcome?: RunOutcome): RunWorkStateInput {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const inferredStatus = outcome === "done"
    ? "done"
    : outcome === "blocked"
      ? "blocked"
      : outcome === "needs_user_input"
        ? "needs_user_input"
        : "not_done";
  const status = ["not_done", "done", "blocked", "needs_user_input"].includes(
    String(state["status"]),
  )
    ? state["status"] as RunWorkStateInput["status"]
    : inferredStatus;
  return {
    status,
    summary: typeof state["summary"] === "string"
      ? state["summary"]
      : outcome
        ? "Run ended with outcome " + outcome + "."
        : "Run in progress.",
    openWork: strings(state["openWork"]),
    blockers: strings(state["blockers"]),
    facts: strings(state["verifiedFacts"] ?? state["facts"]),
    evidence: strings(state["evidence"]),
    artifacts: strings(state["artifacts"]),
    nextStep: typeof state["nextStep"] === "string" ? state["nextStep"] : null,
    userInputNeeded: typeof state["userInputNeeded"] === "string"
      ? [state["userInputNeeded"]]
      : strings(state["userInputNeeded"]),
  };
}

function preparationRequestId(
  clientId: string,
  role: "user" | "system_event",
  content: string,
  at: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ clientId, role, content, at }))
    .digest("hex")
    .slice(0, 24);
  return "prepare:" + digest;
}

function operationRequestId(runId: string, operation: string): string {
  return runId + ":" + operation;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function localDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
