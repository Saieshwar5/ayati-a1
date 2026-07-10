import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { createTimelineCheckpointCache } from "../../src/ivec/agent-runner/timeline-checkpoint-cache.js";
import { generateTimelineCheckpoint } from "../../src/ivec/agent-runner/timeline-checkpoint-generator.js";
import { planTimelineCheckpoint } from "../../src/ivec/agent-runner/timeline-checkpoint.js";
import type { ExactTimelineEvent } from "../../src/ivec/agent-runner/timeline-checkpoint.js";

describe("timeline checkpoint generator", () => {
  it("generates strict structured output and reuses the success cache", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validSummary()),
    }));
    const provider = createProvider(generateTurn);
    const cache = createTimelineCheckpointCache();
    const plan = checkpointPlan();

    const generated = await generateTimelineCheckpoint({ provider, plan, cache });
    const cached = await generateTimelineCheckpoint({ provider, plan, cache });

    expect(generated).toMatchObject({
      status: "success",
      cacheStatus: "generated",
      checkpoint: {
        kind: "checkpoint",
        coveredFromSeq: plan.coveredFromSeq,
        coveredToSeq: plan.coveredToSeq,
        sourceHash: plan.sourceHash,
      },
    });
    expect(cached).toMatchObject({
      status: "success",
      cacheStatus: "success_hit",
      attempts: [],
    });
    expect(generateTurn).toHaveBeenCalledTimes(1);
    const turnInput = generateTurn.mock.calls[0]?.[0];
    expect(turnInput?.tools).toBeUndefined();
    expect(turnInput?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "timeline_checkpoint_summary",
      strict: true,
    });
  });

  it("repairs one invalid source reference", async () => {
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({
        type: "assistant",
        content: JSON.stringify(validSummary({ constraints: [{ seq: 999, text: "Invented" }] })),
      })
      .mockResolvedValueOnce({
        type: "assistant",
        content: JSON.stringify(validSummary()),
      });
    const result = await generateTimelineCheckpoint({
      provider: createProvider(generateTurn),
      plan: checkpointPlan(),
      cache: createTimelineCheckpointCache(),
    });

    expect(result.status).toBe("success");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "success"]);
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[1]?.[0]?.messages[0]?.content).toContain(
      "checkpoint statement seq 999 is not in the selected source events",
    );
  });

  it("negative-caches repeated invalid output", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: "not-json",
    }));
    const provider = createProvider(generateTurn);
    const cache = createTimelineCheckpointCache();
    const plan = checkpointPlan();

    const failed = await generateTimelineCheckpoint({ provider, plan, cache });
    const cachedFailure = await generateTimelineCheckpoint({ provider, plan, cache });

    expect(failed).toMatchObject({
      status: "failed",
      cacheStatus: "generated",
    });
    expect(failed.attempts).toHaveLength(2);
    expect(cachedFailure).toMatchObject({
      status: "failed",
      cacheStatus: "failure_hit",
      attempts: [],
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects checkpoint output above the planned token budget", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validSummary({ narrative: "n".repeat(20_000) })),
    }));
    const result = await generateTimelineCheckpoint({
      provider: createProvider(generateTurn),
      plan: checkpointPlan(),
      cache: createTimelineCheckpointCache(),
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((error) => error.includes("exceeding the 1200-token budget"))).toBe(true);
    expect(generateTurn).toHaveBeenCalledTimes(2);
  });

  it("does not send a checkpoint request above the generator input capacity", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validSummary()),
    }));
    const result = await generateTimelineCheckpoint({
      provider: createProvider(generateTurn),
      plan: checkpointPlan(),
      cache: createTimelineCheckpointCache(),
      maxInputTokens: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((error) => error.includes("checkpoint generator input requires"))).toBe(true);
    expect(generateTurn).not.toHaveBeenCalled();
  });

  it("separates cached checkpoints by output budget", async () => {
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validSummary()),
    }));
    const provider = createProvider(generateTurn);
    const cache = createTimelineCheckpointCache();
    const events = timelineEvents();
    const firstPlan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 100,
      estimatedCheckpointTokens: 1_200,
    });
    const secondPlan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 100,
      estimatedCheckpointTokens: 1_500,
    });

    expect(firstPlan.sourceHash).toBe(secondPlan.sourceHash);
    await generateTimelineCheckpoint({ provider, plan: firstPlan, cache });
    await generateTimelineCheckpoint({ provider, plan: secondPlan, cache });

    expect(generateTurn).toHaveBeenCalledTimes(2);
  });
});

function createProvider(
  generateTurn: (input: LlmTurnInput) => Promise<LlmTurnOutput>,
): LlmProvider {
  return {
    name: "fake-provider",
    version: "test-model",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: { jsonObject: true, jsonSchema: true },
    },
    start() {},
    stop() {},
    generateTurn,
  };
}

function checkpointPlan() {
  return planTimelineCheckpoint({
    events: timelineEvents(),
    requiredSavingsTokens: 1_000,
    estimatedCheckpointTokens: 1_200,
  });
}

function timelineEvents(): ExactTimelineEvent[] {
  return Array.from({ length: 8 }, (_, index): ExactTimelineEvent => ({
    kind: index % 2 === 0 ? "user" : "assistant",
    seq: index + 1,
    timestamp: `2026-07-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    content: index === 7 ? "current" : `${index + 1}:${"x".repeat(10_000)}`,
    ...(index === 7 ? { current: true } : {}),
  }));
}

function validSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userRequests: [{ seq: 1, text: "Preserve the original request." }],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "The user provided the original request.",
    ...overrides,
  };
}
