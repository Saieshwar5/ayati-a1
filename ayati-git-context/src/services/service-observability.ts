import type {
  ActiveContext,
  RecordRunStepRequest,
  RecordRunStepResponse,
  SelectedWorkstreamForRunResponse,
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
      workstreamId: context.activeWorkstream?.workstream.workstreamId,
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
        readContextEntryCount: context.readContext
          ? context.readContext.inventory.length
            + context.readContext.discovery.length
            + context.readContext.evidence.length
            + context.readContext.actions.length
          : 0,
        readContextInventoryCount: context.readContext?.inventory.length ?? 0,
        readContextDiscoveryCount: context.readContext?.discovery.length ?? 0,
        readContextEvidenceCount: context.readContext?.evidence.length ?? 0,
        readContextActionCount: context.readContext?.actions.length ?? 0,
        readContextCounts: {
          inventory: context.readContext?.inventory.length ?? 0,
          discovery: context.readContext?.discovery.length ?? 0,
          evidence: context.readContext?.evidence.length ?? 0,
          actions: context.readContext?.actions.length ?? 0,
          total: context.readContext
            ? context.readContext.inventory.length
              + context.readContext.discovery.length
              + context.readContext.evidence.length
              + context.readContext.actions.length
            : 0,
        },
        readContextAfterCommitRunId: context.readContext?.afterCommitRunId,
        workstreamCandidateCount: context.workstreamCandidates?.length ?? 0,
        ...counters,
      },
    });
  }

  cacheInvalidated(reason: string, input: {
    sessionId?: string;
    runId?: string;
    workstreamId?: string;
    previousRevision?: string;
    scope?: "session" | "all";
    invalidatedEntries?: number;
  }): void {
    if (input.sessionId) this.cacheCounters(input.sessionId).invalidations += 1;
    this.emit({
      level: "debug",
      event: "active_context_invalidated",
      sessionId: input.sessionId,
      runId: input.runId,
      workstreamId: input.workstreamId,
      outcome: "succeeded",
      data: {
        reason,
        scope: input.scope ?? (input.sessionId ? "session" : "all"),
        invalidatedEntries: input.invalidatedEntries ?? 0,
        ...(input.previousRevision ? { previousContextRevision: input.previousRevision } : {}),
      },
    });
  }

  workstreamSelected(mode: "created" | "activated", result: SelectedWorkstreamForRunResponse): void {
    this.emit({
      level: "info",
      event: "run_workstream_bound",
      sessionId: result.run.sessionId,
      conversationId: result.run.conversationId,
      runId: result.run.runId,
      workstreamId: result.workstream.workstreamId,
      outcome: "succeeded",
      data: {
        mode,
        runIdPreserved: true,
        contextRepositoryPath: result.workstream.contextRepositoryPath,
        workstreamHead: result.workstream.head,
        primaryResourceCount: result.context.resources?.filter((entry) => entry.primary).length ?? 0,
        branch: result.workstream.branch,
        workstreamCreated: result.workstreamCreated,
        requestDecision: result.workstreamRequestDecision,
        requestId: result.run.workstreamBinding?.requestId,
        requestStatus: result.workstreamRequestStatus,
        requestCreated: result.workstreamRequestCreated,
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
      step: input.record.step,
      outcome: "succeeded",
      data: {
        tools: input.record.toolCalls.map((call) => call.tool),
        toolEffects: input.record.toolCalls.map((call) => call.toolEffect),
        status: input.record.status,
        workStateRevision: result.run.workState.revision,
        afterStep: result.run.workState.afterStep,
        recordBytes: serializedBytes(input.record),
        verificationPassed: verificationPassed(input.record.verification),
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
