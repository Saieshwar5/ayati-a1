import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTokenUsage } from "../../src/core/contracts/llm-protocol.js";
import { compileResolverContext } from "../../src/ivec/context-preparation/resolver-admission.js";
import { createResolverPreparationJob } from "../../src/ivec/context-preparation/resolver-candidates.js";
import { projectResolverContext } from "../../src/ivec/context-preparation/resolver-context.js";
import { ContextPreparationManager } from "../../src/ivec/context-preparation/manager.js";
import type { RunFocusSummary } from "../../src/ivec/context-preparation/types.js";
import type { ResolutionDecisionContext } from "../../src/ivec/workstream-resolution/decision.js";
import type {
  ResolutionStepHistory,
  ResolutionWorkState,
} from "../../src/ivec/workstream-resolution/types.js";

describe("isolated resolver context preparation", () => {
  it("projects older successes to typed references while preserving failures and the latest two steps", () => {
    const context = resolverContext([
      step(1, "completed", {
        candidateId: "W-20260721-0001",
        requestId: "R-0001",
        head: "abc123",
        description: "Candidate one",
        evidenceRef: "evidence:one",
      }),
      step(2, "failed", undefined),
      step(3, "completed", { resourceId: "RES-1", summary: "Owned resource" }),
      step(4, "completed", { candidateId: "W-20260721-0004" }),
      step(5, "completed", { candidateId: "W-20260721-0005" }),
    ]);

    const projected = projectResolverContext(context);

    expect(projected.context.history.map((item) => item.step)).toEqual([2, 4, 5]);
    expect(projected.context.projectedHistory).toMatchObject({
      candidateIds: ["W-20260721-0001"],
      ownershipIds: ["RES-1"],
      requestIds: ["R-0001"],
      heads: ["abc123"],
      descriptions: ["Candidate one", "Owned resource"],
      evidenceRefs: ["evidence:one"],
    });
    expect(projected.receipt.removedSuccessfulStepCount).toBe(2);
  });

  it("adopts a resolver-only focus, persists its receipt, and exposes aggregate usage", async () => {
    const context = resolverContext([
      step(1, "completed", { candidateId: "W-20260721-0001" }),
      step(2, "completed", { resourceId: "RES-2" }),
      step(3, "completed", { requestId: "R-0003" }),
      step(4, "completed", { head: "def456" }),
    ]);
    const tokenUsage = usage(30, 8, 4);
    const generateTurn = vi.fn().mockResolvedValue({
      type: "assistant" as const,
      content: JSON.stringify(resolverFocus()),
      usage: tokenUsage,
    });
    const llm = provider(generateTurn);
    const manager = new ContextPreparationManager({
      laneId: "resolver:RESOLUTION-1",
      provider: llm,
    });
    const job = createResolverPreparationJob({
      provider: llm,
      laneId: manager.laneId,
      context,
      currentInputTokens: 40_000,
      recoveryTargetTokens: 24_000,
      modelProfileVersion: profileVersion(),
      synchronous: true,
    });
    if (!job) throw new Error("Expected a resolver focus job.");
    const candidate = await manager.prepareSynchronously(job);
    if (!candidate) throw new Error("Expected a ready resolver candidate.");

    const compilation = await compileResolverContext({
      provider: llm,
      context,
      limits: resolverLimits(),
      manager,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: false,
    });

    expect(compilation.context.history.map((item) => item.step)).toEqual([3, 4]);
    expect(compilation.context.focus).toEqual(resolverFocus());
    expect(compilation.persistedContext.contextPreparation).toMatchObject({
      schemaVersion: 2,
      candidateAction: "adopted",
      candidate: {
        laneId: "resolver:RESOLUTION-1",
        kind: "resolver_focus",
        status: "adopted",
      },
    });
    expect(compilation.backgroundUsage?.usage).toEqual(tokenUsage);
    expect(compilation.persistedContext).not.toHaveProperty("context.workState");
  });

  it("returns a typed safe failure when isolated recovery cannot cross the forced barrier", async () => {
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "test",
      model: "test-model",
      inputTokens: 95_000,
      exact: true,
    });
    const generateTurn = vi.fn();
    const llm = provider(generateTurn, countInputTokens);
    const manager = new ContextPreparationManager({ laneId: "resolver:RESOLUTION-2", provider: llm });
    const context = resolverContext([]);
    context.currentInput = "x".repeat(300_000);

    await expect(compileResolverContext({
      provider: llm,
      context,
      limits: resolverLimits(),
      manager,
      allowBackgroundPreparation: false,
      allowSynchronousSemanticRecovery: true,
    })).rejects.toMatchObject({
      name: "ResolverContextLimitError",
      receipt: {
        admitted: true,
        recoveryExhausted: true,
        forcedBarrierTokens: 92_000,
      },
    });
    expect(generateTurn).not.toHaveBeenCalled();
    expect(countInputTokens).toHaveBeenCalled();
    expect(manager.currentCandidate()).toBeUndefined();
  });

  it("does not share candidate slots between main and resolver lanes", () => {
    const llm = provider(vi.fn());
    const main = new ContextPreparationManager({ laneId: "main:RUN-1", provider: llm });
    const resolver = new ContextPreparationManager({ laneId: "resolver:RESOLUTION-3", provider: llm });
    expect(main.laneId).toBe("main:RUN-1");
    expect(resolver.laneId).toBe("resolver:RESOLUTION-3");
    main.setOverlay({ owner: "main" });
    resolver.setOverlay({ owner: "resolver" });
    expect(main.activeOverlay()).toEqual({ owner: "main" });
    expect(resolver.activeOverlay()).toEqual({ owner: "resolver" });
  });
});

function resolverContext(history: ResolutionStepHistory[]): ResolutionDecisionContext {
  return {
    activityId: "RESOLUTION-1",
    currentInput: "Resolve the current request.",
    hints: [],
    previousConversation: [{ role: "user", content: "Earlier user context" }],
    ingressResources: [{ resourceId: "RES-current" }],
    initialCandidates: [],
    state: state(),
    history,
    remaining: { turns: 3, toolCalls: 10 },
  };
}

function step(
  number: number,
  status: "completed" | "failed",
  output: unknown,
): ResolutionStepHistory {
  const call = {
    id: `resolver-call-${number}`,
    tool: "resolution_search_workstreams",
    input: { query: `query-${number}` },
    status,
    ...(status === "completed"
      ? { output }
      : { error: { code: "FAILED", message: `failure-${number}`, retryable: true } }),
  } as const;
  return {
    step: number,
    decision: { calls: [{ id: call.id, tool: call.tool, input: call.input }] },
    toolCalls: [call],
    verification: {
      passed: status === "completed",
      summary: status === "completed" ? "Verified" : "Failed",
    },
    stateAfter: state(),
  };
}

function state(): ResolutionWorkState {
  return {
    status: "searching",
    purpose: "Resolve the current request.",
    searches: [],
    candidates: [],
    resourceOwnership: [],
    failures: [],
  };
}

function resolverFocus(): RunFocusSummary {
  return {
    schemaVersion: 1,
    coveredStepRange: { fromStep: 1, toStep: 2 },
    goal: "Resolve the current request.",
    constraints: [],
    decisions: [],
    completedWork: [],
    importantFindings: [{ text: "Earlier resolver checks found candidates.", refs: ["resolver-step:1"] }],
    artifacts: [],
    unresolvedQuestions: [],
    references: ["resolver-step:1"],
  };
}

function usage(inputTokens: number, outputTokens: number, cachedInputTokens?: number): LlmTokenUsage {
  return {
    provider: "test",
    model: "test-model",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    exact: true,
  };
}

function provider(
  generateTurn: LlmProvider["generateTurn"],
  countInputTokens?: LlmProvider["countInputTokens"],
): LlmProvider {
  return {
    name: "test",
    version: "test-model",
    capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
    start() {},
    stop() {},
    ...(countInputTokens ? { countInputTokens } : {}),
    generateTurn,
  };
}

function resolverLimits() {
  return {
    provider: "test",
    model: "test-model",
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    preparationInputTokens: 20_000,
    recoveryTargetTokens: 24_000,
    softInputTokens: 32_000,
    hardInputTokens: 100_000,
    source: "configured" as const,
  };
}

function profileVersion(): string {
  return "test:test-model:128000:auto:8192:20000:24000:32000:100000";
}
