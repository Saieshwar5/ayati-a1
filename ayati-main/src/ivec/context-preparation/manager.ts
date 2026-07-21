import type { LlmProvider } from "../../core/contracts/provider.js";
import { canonicalHash } from "./canonical.js";
import { planFlexibleLaneAllocation } from "./policy.js";
import {
  providerBackgroundSummaryScheduler,
  type BackgroundTaskResult,
  type ProviderBackgroundSummaryScheduler,
} from "./background-scheduler.js";
import type {
  ContextPreparationBackgroundUsage,
  ContextPreparationCandidate,
  ContextPreparationCandidateKind,
  ContextPreparationEvent,
  ContextPreparationLaneId,
  PromptContextManifest,
} from "./types.js";

type CandidateSeed = Omit<
  ContextPreparationCandidate,
  | "candidateId"
  | "jobKey"
  | "laneId"
  | "kind"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "background"
  | "failureReason"
  | "lifecycleReason"
>;

export interface ContextPreparationJobContext {
  runSemanticBackground<Value>(key: string, task: () => Promise<Value>): Promise<BackgroundTaskResult<Value>>;
  runSemanticSynchronously<Value>(key: string, task: () => Promise<Value>): Promise<BackgroundTaskResult<Value>>;
}

export interface ContextPreparationJob {
  jobKey: string;
  kind: ContextPreparationCandidateKind;
  seed: CandidateSeed;
  prepare(context: ContextPreparationJobContext): Promise<Partial<ContextPreparationCandidate>>;
}

export class ContextPreparationJobError extends Error {
  constructor(
    message: string,
    readonly background?: ContextPreparationBackgroundUsage,
  ) {
    super(message);
    this.name = "ContextPreparationJobError";
  }
}

export interface ContextPreparationStartResult {
  status: "started" | "deduplicated" | "skipped";
  reason?: string;
  candidate?: ContextPreparationCandidate;
}

export interface ContextPreparationManagerOptions {
  laneId: ContextPreparationLaneId;
  provider: LlmProvider;
  scheduler?: ProviderBackgroundSummaryScheduler;
  now?: () => Date;
}

export class ContextPreparationManager {
  readonly laneId: ContextPreparationLaneId;
  private readonly scheduler: ProviderBackgroundSummaryScheduler;
  private readonly now: () => Date;
  private slot?: ContextPreparationCandidate;
  private jobPromise?: Promise<ContextPreparationCandidate | undefined>;
  private closed = false;
  private generation = 0;
  private overlay?: unknown;
  private readonly unreportedBackgroundUsage: ContextPreparationBackgroundUsage[] = [];
  private readonly events: ContextPreparationEvent[] = [];

  constructor(options: ContextPreparationManagerOptions) {
    this.laneId = options.laneId;
    this.scheduler = options.scheduler ?? providerBackgroundSummaryScheduler(options.provider);
    this.now = options.now ?? (() => new Date());
  }

  startBackground(job: ContextPreparationJob): ContextPreparationStartResult {
    if (this.closed) return this.skipped("lane_closed");
    const existing = this.slot;
    if (existing && existing.jobKey === job.jobKey && existing.status !== "failed") {
      this.emit("context_preparation_deduplicated", {
        candidateId: existing.candidateId,
        jobKey: job.jobKey,
        kind: existing.kind,
        status: existing.status,
      });
      return { status: "deduplicated", candidate: structuredClone(existing) };
    }
    if (existing && ["preparing", "ready"].includes(existing.status)) {
      return this.skipped("candidate_slot_occupied");
    }

    const candidate = this.createPreparingCandidate(job);
    const generation = ++this.generation;
    this.slot = candidate;
    this.emit("context_preparation_triggered", {
      candidateId: candidate.candidateId,
      jobKey: job.jobKey,
      kind: job.kind,
      background: true,
    });
    this.jobPromise = this.runJob(job, candidate, generation, "background");
    return { status: "started", candidate: structuredClone(candidate) };
  }

  async prepareSynchronously(job: ContextPreparationJob): Promise<ContextPreparationCandidate | undefined> {
    if (this.closed) {
      this.skipped("lane_closed");
      return undefined;
    }
    if (this.slot?.jobKey === job.jobKey && this.slot.status === "preparing") {
      return await this.awaitRelevant(job.jobKey);
    }
    if (this.slot?.jobKey === job.jobKey && this.slot.status === "ready") {
      return structuredClone(this.slot);
    }
    if (this.slot?.jobKey === job.jobKey && this.slot.status !== "failed") {
      this.emit("context_preparation_deduplicated", {
        candidateId: this.slot.candidateId,
        jobKey: job.jobKey,
        kind: this.slot.kind,
        status: this.slot.status,
        synchronous: true,
      });
      return undefined;
    }
    if (this.slot && ["preparing", "ready"].includes(this.slot.status)) {
      this.transition(this.slot.status === "preparing" ? "discarded" : "stale", "superseded_by_synchronous_recovery");
    }

    const candidate = this.createPreparingCandidate(job);
    const generation = ++this.generation;
    this.slot = candidate;
    this.emit("context_synchronous_fallback", {
      candidateId: candidate.candidateId,
      jobKey: job.jobKey,
      kind: job.kind,
    });
    this.jobPromise = this.runJob(job, candidate, generation, "synchronous");
    return await this.jobPromise;
  }

  async awaitRelevant(jobKey?: string): Promise<ContextPreparationCandidate | undefined> {
    if (!this.jobPromise || this.slot?.status !== "preparing") {
      return this.readyCandidate(jobKey);
    }
    if (jobKey && this.slot.jobKey !== jobKey) return undefined;
    await this.jobPromise;
    return this.readyCandidate(jobKey);
  }

  readyCandidate(jobKey?: string): ContextPreparationCandidate | undefined {
    if (this.slot?.status !== "ready") return undefined;
    if (jobKey && this.slot.jobKey !== jobKey) return undefined;
    return structuredClone(this.slot);
  }

  currentCandidate(): ContextPreparationCandidate | undefined {
    return this.slot ? structuredClone(this.slot) : undefined;
  }

  consumeBackgroundUsage(): ContextPreparationBackgroundUsage | undefined {
    if (this.unreportedBackgroundUsage.length === 0) return undefined;
    return aggregateBackgroundUsage(this.unreportedBackgroundUsage.splice(0));
  }

  markValidated(candidateId: string, reason = "source_hash_and_tail_valid"): void {
    if (this.slot?.candidateId !== candidateId || this.slot.status !== "ready") return;
    this.emit("context_candidate_validated", {
      candidateId,
      kind: this.slot.kind,
      reason,
      sourceRefCount: this.slot.sourceRefs.length,
      sourceHashCount: Object.keys(this.slot.canonicalSourceHashes).length,
      requiredExactRefCount: this.slot.requiredExactEvidenceRefs.length,
      messagePrefixThroughSeq: this.slot.messagePrefixThroughSeq,
      runStepPrefixThrough: this.slot.runStepPrefixThrough,
    });
  }

  markAdopted(
    candidateId: string,
    reason: string,
    measurement?: { tokensBefore: number; tokensAfter: number },
  ): void {
    if (this.slot?.candidateId !== candidateId || this.slot.status !== "ready") return;
    this.transition("adopted", reason, measurement ? {
      tokensBefore: measurement.tokensBefore,
      tokensAfter: measurement.tokensAfter,
      actualSavingsTokens: Math.max(0, measurement.tokensBefore - measurement.tokensAfter),
      estimatedSavingsTokens: this.slot.estimatedSavingsTokens,
      targetReached: this.slot.targetReached,
    } : {});
  }

  markStale(candidateId: string, reason: string): void {
    if (this.slot?.candidateId !== candidateId) return;
    this.transition("stale", reason);
  }

  markDiscarded(
    candidateId: string,
    reason: string,
    data: Record<string, unknown> = {},
  ): void {
    if (this.slot?.candidateId !== candidateId) return;
    this.transition("discarded", reason, data);
  }

  setOverlay<Value>(value: Value): void {
    this.overlay = value;
  }

  activeOverlay<Value>(): Value | undefined {
    return this.overlay as Value | undefined;
  }

  clearOverlay(): void {
    this.overlay = undefined;
  }

  recordManifest(manifest: PromptContextManifest, hardInputTokens?: number): void {
    const lanePlan = hardInputTokens !== undefined
      ? planFlexibleLaneAllocation({ hardInputTokens, demand: manifest.laneEstimates })
      : undefined;
    this.emit("context_manifest_measured", {
      policyVersion: manifest.policyVersion,
      laneEstimates: manifest.laneEstimates,
      toolSchemaTokens: manifest.toolSchemaTokens,
      totalLocalEstimate: manifest.totalLocalEstimate,
      ...(lanePlan ? {
        laneTargets: lanePlan.targets,
        laneAllocated: lanePlan.allocated,
        laneBorrowed: lanePlan.borrowed,
        laneFitsTotalBudget: lanePlan.fitsTotalBudget,
      } : {}),
    });
  }

  recordSkip(reason: string, data: Record<string, unknown> = {}): void {
    this.emit("context_preparation_skipped", { reason, ...data });
  }

  recordLimitTermination(data: Record<string, unknown>): void {
    this.emit("context_limit_termination", data);
  }

  drainEvents(): ContextPreparationEvent[] {
    return this.events.splice(0).map((event) => structuredClone(event));
  }

  close(reason = "lane_finalized"): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.overlay = undefined;
    if (this.slot && ["preparing", "ready"].includes(this.slot.status)) {
      this.transition("discarded", reason);
    }
  }

  private async runJob(
    job: ContextPreparationJob,
    candidate: ContextPreparationCandidate,
    generation: number,
    mode: "background" | "synchronous",
  ): Promise<ContextPreparationCandidate | undefined> {
    try {
      const prepared = await job.prepare({
        runSemanticBackground: async <Value>(key: string, task: () => Promise<Value>) => {
          const scheduled = this.scheduler.schedule(key, task);
          if (scheduled.status === "busy") {
            return {
              status: "failed",
              durationMs: 0,
              error: `background summary slot is occupied by ${scheduled.activeKey}`,
            };
          }
          if (scheduled.status === "deduplicated") {
            this.emit("context_preparation_deduplicated", { jobKey: key, semantic: true });
          }
          return await scheduled.promise;
        },
        runSemanticSynchronously: async <Value>(key: string, task: () => Promise<Value>) => {
          return await this.scheduler.runWhenAvailable(key, task);
        },
      });
      if (this.closed || generation !== this.generation || this.slot?.candidateId !== candidate.candidateId) {
        this.emit("context_candidate_discarded", {
          candidateId: candidate.candidateId,
          kind: candidate.kind,
          reason: "late_completion_after_invalidation",
          durationMs: prepared.background?.durationMs,
          attempts: prepared.background?.attempts,
          inputTokens: prepared.background?.usage?.inputTokens,
          outputTokens: prepared.background?.usage?.outputTokens,
          cachedInputTokens: prepared.background?.usage?.cachedInputTokens,
          costUsd: prepared.background?.cost?.totalCostUsd,
        });
        return undefined;
      }
      const at = this.now().toISOString();
      this.slot = {
        ...candidate,
        ...prepared,
        candidateId: candidate.candidateId,
        jobKey: candidate.jobKey,
        laneId: candidate.laneId,
        kind: prepared.kind ?? candidate.kind,
        status: "ready",
        createdAt: candidate.createdAt,
        updatedAt: at,
      };
      this.emit("context_candidate_ready", {
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        estimatedSavingsTokens: this.slot.estimatedSavingsTokens,
        estimatedFinalInputTokens: this.slot.estimatedFinalInputTokens,
        targetReached: this.slot.targetReached,
        mode,
      });
      if (this.slot.background) {
        this.unreportedBackgroundUsage.push(structuredClone(this.slot.background));
        this.emit("context_background_summary_completed", {
          candidateId: candidate.candidateId,
          kind: candidate.kind,
          durationMs: this.slot.background.durationMs,
          attempts: this.slot.background.attempts,
          inputTokens: this.slot.background.usage?.inputTokens,
          outputTokens: this.slot.background.usage?.outputTokens,
          cachedInputTokens: this.slot.background.usage?.cachedInputTokens,
          costUsd: this.slot.background.cost?.totalCostUsd,
        });
      }
      return structuredClone(this.slot);
    } catch (error) {
      if (this.closed || generation !== this.generation || this.slot?.candidateId !== candidate.candidateId) {
        return undefined;
      }
      const background = error instanceof ContextPreparationJobError
        ? error.background
        : undefined;
      this.slot = {
        ...candidate,
        ...(background ? { background } : {}),
        status: "failed",
        updatedAt: this.now().toISOString(),
        failureReason: error instanceof Error ? error.message : String(error),
      };
      if (background) this.unreportedBackgroundUsage.push(structuredClone(background));
      this.emit("context_candidate_failed", {
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        reason: this.slot.failureReason,
        mode,
        durationMs: background?.durationMs,
        attempts: background?.attempts,
        inputTokens: background?.usage?.inputTokens,
        outputTokens: background?.usage?.outputTokens,
        cachedInputTokens: background?.usage?.cachedInputTokens,
        costUsd: background?.cost?.totalCostUsd,
      });
      return undefined;
    }
  }

  private createPreparingCandidate(job: ContextPreparationJob): ContextPreparationCandidate {
    const at = this.now().toISOString();
    return {
      ...job.seed,
      candidateId: `CTX-${canonicalHash({ laneId: this.laneId, jobKey: job.jobKey }).slice(7, 31).toUpperCase()}`,
      jobKey: job.jobKey,
      laneId: this.laneId,
      kind: job.kind,
      status: "preparing",
      createdAt: at,
      updatedAt: at,
    };
  }

  private transition(
    status: "adopted" | "stale" | "discarded",
    reason: string,
    data: Record<string, unknown> = {},
  ): void {
    if (!this.slot) return;
    this.slot = {
      ...this.slot,
      status,
      lifecycleReason: reason,
      updatedAt: this.now().toISOString(),
    };
    const event = status === "adopted"
      ? "context_candidate_adopted"
      : status === "stale"
        ? "context_candidate_stale"
        : "context_candidate_discarded";
    this.emit(event, {
      candidateId: this.slot.candidateId,
      kind: this.slot.kind,
      reason,
      ...data,
    });
  }

  private skipped(reason: string): ContextPreparationStartResult {
    this.recordSkip(reason);
    return { status: "skipped", reason };
  }

  private emit(event: ContextPreparationEvent["event"], data: Record<string, unknown>): void {
    this.events.push({ event, laneId: this.laneId, at: this.now().toISOString(), data });
  }
}

function aggregateBackgroundUsage(
  values: ContextPreparationBackgroundUsage[],
): ContextPreparationBackgroundUsage {
  const usage = values.flatMap((value) => value.usage ? [value.usage] : []);
  const cost = values.flatMap((value) => value.cost ? [value.cost] : []);
  const lastUsage = usage.at(-1);
  const lastCost = cost.at(-1);
  return {
    durationMs: values.reduce((sum, value) => sum + value.durationMs, 0),
    attempts: values.reduce((sum, value) => sum + value.attempts, 0),
    ...(lastUsage ? {
      usage: {
        provider: lastUsage.provider,
        model: lastUsage.model,
        inputTokens: usage.reduce((sum, value) => sum + value.inputTokens, 0),
        outputTokens: usage.reduce((sum, value) => sum + value.outputTokens, 0),
        totalTokens: usage.reduce((sum, value) => sum + value.totalTokens, 0),
        ...(usage.some((value) => value.cachedInputTokens !== undefined) ? {
          cachedInputTokens: usage.reduce((sum, value) => sum + (value.cachedInputTokens ?? 0), 0),
        } : {}),
        exact: usage.every((value) => value.exact),
      },
    } : {}),
    ...(lastCost ? {
      cost: {
        currency: "USD",
        inputCostUsd: cost.reduce((sum, value) => sum + value.inputCostUsd, 0),
        cachedInputCostUsd: cost.reduce((sum, value) => sum + value.cachedInputCostUsd, 0),
        outputCostUsd: cost.reduce((sum, value) => sum + value.outputCostUsd, 0),
        totalCostUsd: cost.reduce((sum, value) => sum + value.totalCostUsd, 0),
        pricingSource: lastCost.pricingSource,
      },
    } : {}),
  };
}
