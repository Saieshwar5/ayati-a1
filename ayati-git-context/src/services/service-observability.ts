import type {
  ActiveContext,
  RecordRunStepRequest,
  RecordRunStepResponse,
  SelectedTaskRunResponse,
} from "../contracts.js";
import { GitContextObserver } from "../observability.js";

interface CacheCounters {
  hits: number;
  misses: number;
  invalidations: number;
  builds: number;
}

export class GitContextServiceObservability {
  private readonly cacheBySession = new Map<string, CacheCounters>();

  constructor(private readonly observer: GitContextObserver) {}

  emit(input: Parameters<GitContextObserver["emit"]>[0]): void {
    this.observer.emit(input);
  }

  cacheHit(sessionId: string, revision: string): void {
    const counters = this.cacheCounters(sessionId);
    counters.hits += 1;
    this.emit({
      level: "debug",
      event: "active_context_cache_hit",
      sessionId,
      outcome: "succeeded",
      data: { contextRevision: revision, ...counters },
    });
  }

  cacheMiss(sessionId: string, revision: string, previousRevision?: string): void {
    const counters = this.cacheCounters(sessionId);
    counters.misses += 1;
    this.emit({
      level: "debug",
      event: "active_context_cache_miss",
      sessionId,
      outcome: "started",
      data: {
        contextRevision: revision,
        ...(previousRevision ? { previousContextRevision: previousRevision } : {}),
        ...counters,
      },
    });
  }

  cacheBuilt(context: ActiveContext, durationMs: number, previousRevision?: string): void {
    const sessionId = context.session?.session.sessionId;
    if (!sessionId) return;
    const counters = this.cacheCounters(sessionId);
    counters.builds += 1;
    this.emit({
      level: "info",
      event: "active_context_built",
      sessionId,
      runId: context.run?.run.runId,
      taskId: context.activeTask?.task.taskId,
      durationMs,
      outcome: "succeeded",
      data: {
        contextRevision: context.contextRevision,
        ...(previousRevision && previousRevision !== context.contextRevision
          ? { previousContextRevision: previousRevision }
          : {}),
        conversationCount: context.session?.pendingConversationContext.length ?? 0,
        runStepCount: context.run?.steps.length ?? 0,
        readContextRevision: context.readContext?.revision,
        readContextEntryCount: context.readContext?.entries.length ?? 0,
        readContextAfterTaskRunId: context.readContext?.afterTaskRunId,
        taskCandidateCount: context.taskCandidates?.length ?? 0,
        ...counters,
      },
    });
  }

  cacheInvalidated(reason: string, input: {
    sessionId?: string;
    runId?: string;
    taskId?: string;
    previousRevision?: string;
  }): void {
    if (input.sessionId) this.cacheCounters(input.sessionId).invalidations += 1;
    this.emit({
      level: "debug",
      event: "active_context_invalidated",
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      outcome: "succeeded",
      data: {
        reason,
        ...(input.previousRevision ? { previousContextRevision: input.previousRevision } : {}),
      },
    });
  }

  taskSelected(mode: "created" | "activated", result: SelectedTaskRunResponse): void {
    this.emit({
      level: "info",
      event: result.runPromoted ? "run_promoted" : "task_run_started",
      sessionId: result.run.sessionId,
      conversationId: result.run.conversationId,
      runId: result.run.runId,
      taskId: result.task.taskId,
      outcome: "succeeded",
      data: {
        mode,
        fromClass: result.runPromoted ? "session" : "none",
        toClass: "task",
        runIdPreserved: result.runPromoted,
        taskHead: result.task.head,
        checkoutPath: result.mount?.checkoutPath,
        workingPath: result.task.workingPath,
        mountCreated: result.mountCreated,
      },
    });
  }

  runStepPersisted(input: RecordRunStepRequest, result: RecordRunStepResponse): void {
    this.emit({
      level: "info",
      event: "run_step_persisted",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      step: input.step,
      outcome: "succeeded",
      data: {
        tool: input.tool,
        purpose: input.purpose,
        toolEffect: input.toolEffect,
        status: result.toolCall.status,
        workStateRevision: result.workState.revision,
        afterStep: result.workState.afterStep,
        inputBytes: serializedBytes(input.input),
        outputBytes: serializedBytes(input.output),
        ...(input.outputHash ? { outputHash: input.outputHash } : {}),
        verificationPassed: verificationPassed(input.verification),
      },
    });
  }

  private cacheCounters(sessionId: string): CacheCounters {
    const existing = this.cacheBySession.get(sessionId);
    if (existing) return existing;
    const created = { hits: 0, misses: 0, invalidations: 0, builds: 0 };
    this.cacheBySession.set(sessionId, created);
    return created;
  }
}

function serializedBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function verificationPassed(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const passed = (value as Record<string, unknown>)["passed"];
  return typeof passed === "boolean" ? passed : undefined;
}
