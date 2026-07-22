import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { ProviderBackgroundSummaryScheduler } from "../../src/ivec/context-preparation/background-scheduler.js";
import {
  ContextPreparationJobError,
  ContextPreparationManager,
  type ContextPreparationJob,
} from "../../src/ivec/context-preparation/manager.js";

describe("context preparation candidate lifecycle", () => {
  it("deduplicates one prefix job and keeps one provider background summary globally", async () => {
    const scheduler = new ProviderBackgroundSummaryScheduler();
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const first = scheduler.schedule("lane-a", async () => await pending);
    const duplicate = scheduler.schedule("lane-a", async () => "duplicate");
    const busy = scheduler.schedule("lane-b", async () => "other");
    expect(first.status).toBe("started");
    expect(duplicate.status).toBe("deduplicated");
    expect(busy).toMatchObject({ status: "busy", activeKey: "lane-a" });
    release("ready");
    if (first.status === "busy" || duplicate.status === "busy") throw new Error("Unexpected busy result.");
    await expect(first.promise).resolves.toMatchObject({ status: "success", value: "ready" });
    await expect(duplicate.promise).resolves.toMatchObject({ status: "success", value: "ready" });
  });

  it("does not block unrelated foreground provider work while one summary is pending", async () => {
    const scheduler = new ProviderBackgroundSummaryScheduler();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const background = scheduler.schedule("summary", async () => await pending);
    const foreground = vi.fn().mockResolvedValue("foreground-ready");
    await expect(foreground()).resolves.toBe("foreground-ready");
    expect(scheduler.isBusy()).toBe(true);
    release();
    if (background.status === "busy") throw new Error("Unexpected busy result.");
    await background.promise;
  });

  it("deduplicates manager jobs and discards a late result after lane finalization", async () => {
    const provider = fakeProvider();
    const detachedEvents: string[] = [];
    const manager = new ContextPreparationManager({
      laneId: "main:RUN-1",
      provider,
      onDetachedEvent: (event) => detachedEvents.push(`${event.event}:${String(event.data["reason"])}`),
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const job = preparationJob(async () => {
      await pending;
      return { estimatedSavingsTokens: 100, estimatedFinalInputTokens: 50, targetReached: true };
    });
    expect(manager.startBackground(job).status).toBe("started");
    expect(manager.startBackground(job).status).toBe("deduplicated");
    manager.setOverlay({ summary: "temporary" });
    manager.close("run_finalized");
    expect(manager.activeOverlay()).toBeUndefined();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.currentCandidate()).toMatchObject({ status: "discarded", lifecycleReason: "run_finalized" });
    expect(manager.drainEvents().some((event) => {
      return event.event === "context_candidate_discarded"
        && event.data["reason"] === "late_completion_after_invalidation";
    })).toBe(true);
    expect(detachedEvents).toEqual([
      "context_candidate_discarded:run_finalized",
      "context_candidate_discarded:late_completion_after_invalidation",
    ]);
  });

  it("turns background errors into failed candidates without unhandled rejection", async () => {
    const manager = new ContextPreparationManager({ laneId: "main:RUN-2", provider: fakeProvider() });
    const job = preparationJob(async () => {
      throw new Error("summary failed");
    });
    manager.startBackground(job);
    await manager.awaitRelevant(job.jobKey);
    expect(manager.currentCandidate()).toMatchObject({
      status: "failed",
      failureReason: "summary failed",
    });
  });

  it("does not rerun an identical terminal candidate", async () => {
    const manager = new ContextPreparationManager({ laneId: "main:RUN-3", provider: fakeProvider() });
    const prepare = vi.fn().mockResolvedValue({
      estimatedSavingsTokens: 100,
      estimatedFinalInputTokens: 50,
      targetReached: true,
    });
    const job = preparationJob(prepare);
    const ready = await manager.prepareSynchronously(job);
    if (!ready) throw new Error("Expected a ready candidate.");
    manager.markDiscarded(ready.candidateId, "shadow_policy_measured_without_adoption");

    expect(manager.startBackground(job)).toMatchObject({
      status: "deduplicated",
      candidate: { status: "discarded" },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("reports failed semantic usage exactly once", async () => {
    const manager = new ContextPreparationManager({ laneId: "main:RUN-4", provider: fakeProvider() });
    const job = preparationJob(async () => {
      throw new ContextPreparationJobError("invalid anchored summary", {
        durationMs: 25,
        attempts: 2,
        usage: {
          provider: "test",
          model: "test",
          inputTokens: 40,
          outputTokens: 10,
          totalTokens: 50,
          cachedInputTokens: 5,
          exact: true,
        },
      });
    });

    await manager.prepareSynchronously(job);

    expect(manager.currentCandidate()).toMatchObject({
      status: "failed",
      background: { durationMs: 25, attempts: 2, usage: { totalTokens: 50 } },
    });
    expect(manager.consumeBackgroundUsage()).toMatchObject({
      durationMs: 25,
      attempts: 2,
      usage: { totalTokens: 50, cachedInputTokens: 5 },
    });
    expect(manager.consumeBackgroundUsage()).toBeUndefined();
  });
});

function preparationJob(
  prepare: ContextPreparationJob["prepare"],
): ContextPreparationJob {
  return {
    jobKey: "main:RUN-1:prefix:1:run_focus",
    kind: "run_focus",
    seed: {
      canonicalSourceHashes: { "seq:1": "sha256:source" },
      sourceRefs: ["seq:1"],
      requiredExactEvidenceRefs: ["seq:2"],
      policyVersion: 1,
      modelProfileVersion: "test-profile",
      deterministicTransformations: [],
      coveredSourceRefs: [],
      estimatedSavingsTokens: 0,
      estimatedFinalInputTokens: 100,
      targetReached: false,
    },
    prepare,
  };
}

function fakeProvider(): LlmProvider {
  return {
    name: "test",
    version: "test",
    capabilities: { nativeToolCalling: true },
    start() {},
    stop() {},
    async generateTurn() {
      return { type: "assistant", content: "ok" };
    },
  };
}
