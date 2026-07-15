import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type {
  ActiveContext,
  ConversationRef,
  GitContextService,
  RunWorkStateInput,
  SelectedTaskRunResponse,
  TaskPlacement,
} from "ayati-git-context";
import { GitContextObserver } from "ayati-git-context";
import {
  type ContextEngineMachineContext,
  type ContextRunStepRecord,
  type HarnessRunResultForContext,
  type TaskAssetRecord,
} from "../context-engine/index.js";
import type { HarnessContextInput } from "../ivec/harness-context.js";
import { getToolTaxonomy } from "../skills/tool-taxonomy.js";
import { GitContextHarnessCache } from "./git-context-harness-cache.js";

export interface GitContextPreparedTurn {
  status: "ready";
  sessionId: string;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  currentMessageId?: string;
  currentMessageSessionSequence?: number;
  conversationId: string;
  inputRole: "user" | "system_event";
  context: ContextEngineMachineContext;
}

export interface GitContextConversationSeqRange {
  fromSeq: number;
  toSeq: number;
}

export type GitContextRoutedTurn =
  | {
      status: "ready";
      sessionId: string;
      taskId: string;
      branch: string;
      ref: string;
      mode: "created" | "activated";
      runId: string;
      conversationRefs: GitContextConversationSeqRange[];
      harnessContext: HarnessContextInput;
      context: ContextEngineMachineContext;
    }
  | {
      status: "ambiguous";
      sessionId: string;
      reason: string;
      candidates: Array<{ taskId: string; title: string }>;
      harnessContext: HarnessContextInput;
      context: ContextEngineMachineContext;
    };

export interface GitContextRuntimeOptions {
  service: GitContextService;
  timezone: string;
  agentId: string;
  observer?: GitContextObserver;
}

export interface GitContextRuntime {
  warmActiveContext(): Promise<void>;
  prepareUserTurn(input: { clientId: string; userMessage: string; at: string }): Promise<GitContextPreparedTurn>;
  prepareSystemEventTurn(input: { clientId: string; systemMessage: string; at: string }): Promise<GitContextPreparedTurn>;
  startSessionRun(input: { clientId: string; turn: GitContextPreparedTurn | null; at: string }): Promise<{ runId: string } | null>;
  routeTaskTurn(input: { turn: GitContextPreparedTurn | null; autoOnly?: boolean; [key: string]: unknown }): Promise<GitContextRoutedTurn | null>;
  createTaskTurn(input: {
    turn: GitContextPreparedTurn | null;
    title: string;
    objective: string;
    placement: TaskPlacement;
    sessionRunId?: string;
    at: string;
    [key: string]: unknown;
  }): Promise<GitContextRoutedTurn | null>;
  activateTaskTurn(input: {
    turn: GitContextPreparedTurn | null;
    taskId: string;
    sessionRunId?: string;
    at: string;
    [key: string]: unknown;
  }): Promise<GitContextRoutedTurn | null>;
  finalizeSessionRun(input: {
    turn: GitContextPreparedTurn | null;
    runId: string;
    assistantResponse?: string;
    workState?: unknown;
    at: string;
    [key: string]: unknown;
  }): Promise<{ runId: string } | null>;
  completeTaskRun(input: {
    turn: GitContextPreparedTurn | null;
    taskId: string;
    runId?: string;
    result: HarnessRunResultForContext;
    at: string;
    assistantMessage?: string;
    [key: string]: unknown;
  }): Promise<{
    runId: string;
    taskId: string;
    taskCommit: string;
    ref: string;
  } | null>;
  recordSessionRunStep(input: { turn: GitContextPreparedTurn | null; record: ContextRunStepRecord; [key: string]: unknown }): Promise<ContextEngineMachineContext | null>;
  recordTaskRunStep(input: { turn: GitContextPreparedTurn | null; record: ContextRunStepRecord; [key: string]: unknown }): Promise<ContextEngineMachineContext | null>;
  recordAssistantMessage(input: {
    turn: GitContextPreparedTurn | null;
    message: string;
    at: string;
    taskId?: string;
    runId?: string;
    [key: string]: unknown;
  }): Promise<ConversationRef | null>;
  recordSessionAttachments(input: unknown): Promise<null>;
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
    return await this.prepareInput("user", input.userMessage, input.at);
  }

  async prepareSystemEventTurn(input: {
    clientId: string;
    systemMessage: string;
    at: string;
  }): Promise<GitContextPreparedTurn> {
    return await this.prepareInput("system_event", input.systemMessage, input.at);
  }

  async startSessionRun(input: {
    clientId: string;
    turn: GitContextPreparedTurn | null;
    at: string;
  }): Promise<{ runId: string } | null> {
    if (!input.turn) return null;
    const response = await this.options.service.startRun({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      conversationId: input.turn.conversationId,
      trigger: input.turn.inputRole,
      workState: initialWorkState(),
      at: input.at,
    });
    this.contextCache.markDirty(input.turn.sessionId);
    this.observer.emit({
      level: "info",
      event: "session_run_started",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: response.run.runId,
      data: { runClass: "session" },
    });
    return { runId: response.run.runId };
  }

  async routeTaskTurn(_input: {
    turn: GitContextPreparedTurn | null;
    autoOnly?: boolean;
  }): Promise<GitContextRoutedTurn | null> {
    return null;
  }

  async createTaskTurn(input: {
    turn: GitContextPreparedTurn | null;
    title: string;
    objective: string;
    placement: TaskPlacement;
    sessionRunId?: string;
    at: string;
  }): Promise<GitContextRoutedTurn | null> {
    if (!input.turn) return null;
    const selected = await this.options.service.createTaskRun({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      conversationId: input.turn.conversationId,
      ...(input.sessionRunId ? { runId: input.sessionRunId } : {}),
      trigger: "user",
      workState: initialWorkState(),
      title: input.title,
      objective: input.objective,
      placement: input.placement,
      at: input.at,
    });
    this.observer.emit({
      level: "info",
      event: "task_run_selected",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      outcome: "succeeded",
      data: { selectionMode: "created", promoted: selected.runPromoted },
    });
    return await this.routedTurn(selected, input.turn);
  }

  async activateTaskTurn(input: {
    turn: GitContextPreparedTurn | null;
    taskId: string;
    sessionRunId?: string;
    at: string;
  }): Promise<GitContextRoutedTurn | null> {
    if (!input.turn) return null;
    const selected = await this.options.service.activateTaskRun({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      conversationId: input.turn.conversationId,
      ...(input.sessionRunId ? { runId: input.sessionRunId } : {}),
      trigger: "user",
      workState: initialWorkState(),
      taskId: input.taskId,
      at: input.at,
    });
    this.observer.emit({
      level: "info",
      event: "task_run_selected",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: selected.run.runId,
      taskId: selected.task.taskId,
      outcome: "succeeded",
      data: { selectionMode: "activated", promoted: selected.runPromoted },
    });
    return await this.routedTurn(selected, input.turn);
  }

  async finalizeSessionRun(input: {
    turn: GitContextPreparedTurn | null;
    runId: string;
    assistantResponse?: string;
    workState?: unknown;
    at: string;
  }): Promise<{ runId: string } | null> {
    if (!input.turn) return null;
    await this.drainWrites();
    const response = await this.options.service.finalizeSessionRun({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      runId: input.runId,
      assistantResponse: input.assistantResponse ?? "",
      workState: completedSessionWorkState(input.workState),
      at: input.at,
    });
    this.contextCache.markDirty(input.turn.sessionId);
    this.observer.emit({
      level: "info",
      event: "session_run_finalization_completed",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: response.runId,
      outcome: "succeeded",
    });
    return { runId: response.runId };
  }

  async completeTaskRun(input: {
    turn: GitContextPreparedTurn | null;
    taskId: string;
    runId?: string;
    result: HarnessRunResultForContext;
    at: string;
    assistantMessage?: string;
  }): Promise<{ runId: string; taskId: string; taskCommit: string; ref: string } | null> {
    if (!input.turn || !input.runId) return null;
    await this.drainWrites();
    const done = input.result.workState?.status === "done";
    const failed = input.result.status === "failed";
    const needsUser = input.result.workState?.status === "needs_user_input";
    const blocked = input.result.workState?.status === "blocked";
    const active = await this.loadActiveContext(input.turn.sessionId);
    const assets = completionAssets(
      input.result.verifiedCompletionAssets ?? [],
      active.activeTask?.checkoutPath,
    );
    this.observer.emit({
      level: "info",
      event: "task_run_finalization_requested",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: input.runId,
      taskId: input.taskId,
    });
    const response = await this.options.service.finalizeTaskRun({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      outcome: done ? "done" : failed ? "failed" : needsUser ? "needs_user_input" : blocked ? "blocked" : "incomplete",
      conversationSummary: input.result.taskSummary?.summary ?? input.result.content,
      summary: input.result.workState?.summary ?? input.result.taskSummary?.summary ?? input.result.content,
      validation: done ? "passed" : failed ? "failed" : "not_run",
      ...(input.result.workState?.nextStep ? { next: input.result.workState.nextStep } : {}),
      completion: {
        accepted: done,
        assets,
        missing: [],
        failures: failed ? [input.result.content] : [],
        criteria: [{
          criterion: "Harness task completion verification",
          passed: done,
          evidence: input.result.workState?.summary,
        }],
      },
      assistantResponse: input.assistantMessage ?? input.result.content,
      at: input.at,
    });
    this.contextCache.markDirty(input.turn.sessionId);
    this.observer.emit({
      level: "info",
      event: "task_run_finalization_completed",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: response.runId,
      taskId: response.taskId,
      outcome: failed ? "failed" : "succeeded",
      data: {
        completionOutcome: done ? "done" : failed ? "failed" : "incomplete",
        taskCommit: response.taskFinalizationCommit,
      },
    });
    return {
      runId: response.runId,
      taskId: response.taskId,
      taskCommit: response.taskFinalizationCommit,
      ref: "refs/heads/main",
    };
  }

  async recordSessionRunStep(input: {
    turn: GitContextPreparedTurn | null;
    record: ContextRunStepRecord;
  }): Promise<ContextEngineMachineContext | null> {
    return await this.enqueueStep(input.turn, input.record, "read_only");
  }

  async recordTaskRunStep(input: {
    turn: GitContextPreparedTurn | null;
    record: ContextRunStepRecord;
  }): Promise<ContextEngineMachineContext | null> {
    const mutating = input.record.toolCalls.some((call) =>
      getToolTaxonomy(call.tool)?.effect !== "read_only"
    );
    return await this.enqueueStep(input.turn, input.record, mutating ? "mutating" : "read_only");
  }

  async recordAssistantMessage(input: {
    turn: GitContextPreparedTurn | null;
    message: string;
    at: string;
    taskId?: string;
    runId?: string;
  }): Promise<ConversationRef | null> {
    if (!input.turn) return null;
    if (input.runId) {
      throw new Error(
        "Run-bound assistant responses must be persisted by session or task finalization.",
      );
    }
    const response = await this.options.service.appendConversation({
      requestId: randomUUID(),
      sessionId: input.turn.sessionId,
      role: "assistant",
      content: input.message,
      at: input.at,
    });
    const projection = this.contextCache.appendConversation({
      sessionId: input.turn.sessionId,
      conversation: response.conversation,
      message: response.message,
      contextRevision: response.contextRevision,
      pendingDigest: response.pendingDigest,
    });
    this.observer.emit({
      level: "debug",
      event: projection
        ? "harness_context_incrementally_updated"
        : "conversation_cache_update_deferred",
      sessionId: input.turn.sessionId,
      seq: input.turn.messageSeq,
      runId: input.runId,
      data: {
        role: "assistant",
        contextRevision: response.contextRevision,
        ...this.contextCache.getStats(input.turn.sessionId),
      },
    });
    return response.conversation;
  }

  async recordSessionAttachments(_input: unknown): Promise<null> {
    return null;
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
    role: "user" | "system_event",
    content: string,
    at: string,
  ): Promise<GitContextPreparedTurn> {
    const ensured = await this.options.service.ensureActiveSession({
      requestId: randomUUID(),
      date: localDate(at, this.options.timezone),
      timezone: this.options.timezone,
      agentId: this.options.agentId,
      at,
    });
    const appended = await this.options.service.appendConversation({
      requestId: randomUUID(),
      sessionId: ensured.session.sessionId,
      role,
      content,
      at,
    });
    const incrementallyUpdated = this.contextCache.appendConversation({
      sessionId: ensured.session.sessionId,
      conversation: appended.conversation,
      message: appended.message,
      contextRevision: appended.contextRevision,
      pendingDigest: appended.pendingDigest,
    });
    const context = incrementallyUpdated
      ?? await this.refreshActiveContext(ensured.session.sessionId);
    this.observer.emit({
      level: "debug",
      event: "harness_context_turn_prepared",
      sessionId: ensured.session.sessionId,
      outcome: "succeeded",
      data: {
        source: incrementallyUpdated ? "incremental_cache" : "service_snapshot",
        contextRevision: appended.contextRevision,
        ...this.contextCache.getStats(ensured.session.sessionId),
      },
    });
    return {
      status: "ready",
      sessionId: ensured.session.sessionId,
      repoPath: ensured.session.repositoryPath,
      initialized: ensured.created,
      messageSeq: appended.conversation.sequence,
      currentMessageId: appended.message.messageId,
      currentMessageSessionSequence: appended.message.sessionSequence,
      conversationId: appended.conversation.conversationId,
      inputRole: role,
      context,
    };
  }

  private async routedTurn(
    selected: SelectedTaskRunResponse,
    turn: GitContextPreparedTurn,
  ): Promise<GitContextRoutedTurn> {
    const context = await this.refreshActiveContext(turn.sessionId);
    return {
      status: "ready",
      sessionId: turn.sessionId,
      taskId: selected.task.taskId,
      branch: selected.task.branch,
      ref: "refs/heads/" + selected.task.branch,
      mode: selected.taskCreated ? "created" : "activated",
      runId: selected.run.runId,
      conversationRefs: [{ fromSeq: turn.messageSeq, toSeq: turn.messageSeq }],
      harnessContext: { contextEngine: context },
      context,
    };
  }

  private enqueueStep(
    turn: GitContextPreparedTurn | null,
    record: ContextRunStepRecord,
    toolEffect: "read_only" | "mutating",
  ): Promise<ContextEngineMachineContext | null> {
    if (!turn) return Promise.resolve(null);
    this.contextCache.markDirty(turn.sessionId);
    this.observer.emit({
      level: "debug",
      event: "run_step_persistence_queued",
      sessionId: turn.sessionId,
      seq: turn.messageSeq,
      runId: record.runId,
      step: record.step,
      data: { toolEffect, tools: record.toolCalls.map((item) => item.tool) },
    });
    const persisted = this.writeChain.then(async () => {
      const call = record.toolCalls[0];
      try {
        const response = await this.options.service.recordRunStep({
          requestId: randomUUID(),
          sessionId: turn.sessionId,
          runId: record.runId,
          step: record.step,
          tool: record.toolCalls.map((item) => item.tool).join(", ") || "agent_step",
          toolEffect,
          purpose: record.toolCalls.map((item) => item.purpose).filter(Boolean).join("; ") || record.summary,
          status: record.status === "failed" ? "failed" : record.status === "skipped" ? "blocked" : "completed",
          input: {
            decision: record.decision,
            action: record.action,
            toolCalls: record.toolCalls.map((item) => ({
              callId: item.callId,
              tool: item.tool,
              purpose: item.purpose,
              input: item.input,
            })),
          },
          output: {
            summary: record.summary,
            toolCalls: record.toolCalls.map((item) => ({
              callId: item.callId,
              tool: item.tool,
              output: item.output,
              error: item.error,
            })),
            firstOutput: call?.output,
          },
          verification: record.verification,
          workState: toRunWorkState(record.workStateAfter),
          at: record.completedAt,
        });
        this.observer.emit({
          level: "info",
          event: "run_step_persistence_acknowledged",
          sessionId: turn.sessionId,
          seq: turn.messageSeq,
          runId: record.runId,
          step: record.step,
          outcome: "succeeded",
          data: {
            toolEffect,
            workStateRevision: response.workState.revision,
            afterStep: response.workState.afterStep,
          },
        });
        return await this.refreshActiveContext(turn.sessionId);
      } catch (error) {
        this.observer.emit({
          level: "error",
          event: "run_step_persistence_failed",
          sessionId: turn.sessionId,
          seq: turn.messageSeq,
          runId: record.runId,
          step: record.step,
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    this.writeChain = persisted.then(() => undefined);
    return persisted;
  }

  private async drainWrites(): Promise<void> {
    await this.writeChain;
  }

  private async loadActiveContext(sessionId: string): Promise<ActiveContext> {
    const cached = this.contextCache.getActive(sessionId);
    if (cached) return cached;
    const active = await this.options.service.getActiveContext({ sessionId });
    this.contextCache.set(sessionId, active);
    return active;
  }

  private async refreshActiveContext(sessionId: string): Promise<ContextEngineMachineContext> {
    const startedAt = Date.now();
    const previousRevision = this.contextCache.getStats(sessionId).revision;
    this.observer.emit({
      level: "debug",
      event: "harness_context_refresh_started",
      sessionId,
      data: { previousRevision },
    });
    try {
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
          ...this.contextCache.getStats(sessionId),
        },
      });
      return projection;
    } catch (error) {
      this.observer.emit({
        level: "error",
        event: "harness_context_refresh_failed",
        sessionId,
        durationMs: Date.now() - startedAt,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        data: { previousRevision },
      });
      throw error;
    }
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

function initialWorkState(): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Run started.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

function toRunWorkState(value: unknown): RunWorkStateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return initialWorkState();
  const state = value as Record<string, unknown>;
  const status = ["not_done", "done", "blocked", "needs_user_input"].includes(String(state["status"]))
    ? state["status"] as RunWorkStateInput["status"]
    : "not_done";
  return {
    status,
    summary: typeof state["summary"] === "string" ? state["summary"] : "Run in progress.",
    openWork: strings(state["openWork"]),
    blockers: strings(state["blockers"]),
    facts: strings(state["verifiedFacts"]),
    evidence: strings(state["evidence"]),
    artifacts: strings(state["artifacts"]),
    nextStep: typeof state["nextStep"] === "string" ? state["nextStep"] : null,
    userInputNeeded: typeof state["userInputNeeded"] === "string" ? [state["userInputNeeded"]] : [],
  };
}

function completedSessionWorkState(value: unknown): RunWorkStateInput {
  return { ...toRunWorkState(value), status: "done" };
}

function completionAssets(
  assets: TaskAssetRecord[],
  checkoutPath: string | undefined,
) {
  return assets
    .filter((asset) => asset.role === "generated" || asset.role === "output")
    .filter((asset) => Boolean(asset.path))
    .map((asset) => ({
      path: taskRelativePath(asset.path!, checkoutPath),
      kind: asset.kind === "directory" ? "directory" as const : "file" as const,
      description: asset.description ?? asset.name,
      verified: true,
    }));
}

function taskRelativePath(path: string, checkoutPath?: string): string {
  if (!checkoutPath || !isAbsolute(path)) return path;
  const candidate = relative(checkoutPath, path);
  return candidate === "" ? "." : candidate;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function localDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
