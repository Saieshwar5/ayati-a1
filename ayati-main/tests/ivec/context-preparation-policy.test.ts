import { describe, expect, it } from "vitest";
import type { LlmTurnInput } from "../../src/core/contracts/llm-protocol.js";
import type { AgentPromptStateView } from "../../src/ivec/agent-runner/prompt-context.js";
import {
  contextLaneTargets,
  decideContextPreparationTrigger,
  forcedSynchronousBarrier,
  planFlexibleLaneAllocation,
  resolveResolverContextLimits,
} from "../../src/ivec/context-preparation/policy.js";
import { buildPromptContextManifest } from "../../src/ivec/context-preparation/prompt-manifest.js";
import { removeDuplicateAndInvalidContext } from "../../src/ivec/context-preparation/deterministic-reduction.js";
import { estimateTurnInputTokens } from "../../src/prompt/token-estimator.js";

describe("parallel context preparation policy", () => {
  it("uses flexible 15/25/60 lane targets without overriding total admission", () => {
    expect(contextLaneTargets(100_000)).toEqual({
      system: 15_000,
      session: 25_000,
      work: 60_000,
    });
    const borrowed = planFlexibleLaneAllocation({
      hardInputTokens: 100_000,
      demand: { system: 10_000, session: 10_000, work: 80_000 },
    });
    expect(borrowed.allocated).toEqual({ system: 10_000, session: 10_000, work: 80_000 });
    expect(borrowed.borrowed.work).toBe(20_000);
    expect(borrowed.fitsTotalBudget).toBe(true);

    const overflowing = planFlexibleLaneAllocation({
      hardInputTokens: 100_000,
      demand: { system: 20_000, session: 30_000, work: 60_001 },
    });
    expect(overflowing.fitsTotalBudget).toBe(false);
    expect(Object.values(overflowing.allocated).reduce((sum, value) => sum + value, 0)).toBe(100_000);
  });

  it("starts at 55K or predicted soft pressure and computes exact/local forced barriers", () => {
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 54_999,
      preparationInputTokens: 55_000,
      softInputTokens: 70_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: false, reason: "below_threshold" });
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 55_000,
      preparationInputTokens: 55_000,
      softInputTokens: 70_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: true, reason: "preparation_threshold" });
    expect(decideContextPreparationTrigger({
      measuredInputTokens: 54_000,
      preparationInputTokens: 60_000,
      softInputTokens: 68_000,
      preparationLeadTokens: 15_000,
    })).toMatchObject({ triggered: true, reason: "predicted_soft_pressure" });
    expect(forcedSynchronousBarrier({
      admissionLimitTokens: 95_000,
      softInputTokens: 70_000,
      recoveryTargetTokens: 60_000,
    })).toBe(85_000);
    expect(forcedSynchronousBarrier({
      admissionLimitTokens: 100_000,
      softInputTokens: 70_000,
      recoveryTargetTokens: 60_000,
    })).toBe(90_000);
  });

  it("clamps the isolated resolver profile while keeping thresholds strictly ordered", () => {
    expect(resolveResolverContextLimits({
      provider: "test",
      model: "test",
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
      preparationInputTokens: 55_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
      source: "configured",
    })).toMatchObject({
      preparationInputTokens: 20_000,
      recoveryTargetTokens: 24_000,
      softInputTokens: 32_000,
      hardInputTokens: 100_000,
    });
    expect(resolveResolverContextLimits({
      provider: "test",
      model: "small-policy",
      contextWindowTokens: 128_000,
      outputReserveTokens: 8_192,
      preparationInputTokens: 8_000,
      recoveryTargetTokens: 9_000,
      softInputTokens: 10_000,
      hardInputTokens: 20_000,
      source: "configured",
    })).toMatchObject({
      preparationInputTokens: 19_997,
      recoveryTargetTokens: 19_998,
      softInputTokens: 19_999,
      hardInputTokens: 20_000,
    });
  });

  it("builds a deterministic pre-serialization manifest with exact system and tool parts", () => {
    const stateView = promptState();
    const turnInput: LlmTurnInput = {
      messages: [
        { role: "system", content: "SYSTEM RULES" },
        { role: "user", content: `State view:\n${JSON.stringify(stateView)}` },
      ],
      tools: [{
        name: "read_files",
        description: "Read exact files.",
        inputSchema: { type: "object", properties: { paths: { type: "array" } } },
      }],
    };
    const first = buildPromptContextManifest({ stateView, turnInput });
    const second = buildPromptContextManifest({ stateView, turnInput });
    expect(first).toEqual(second);
    expect(first.totalLocalEstimate).toBe(estimateTurnInputTokens(turnInput).totalTokens);
    expect(first.toolSchemaTokens).toBeGreaterThan(0);
    expect(first.parts.find((part) => part.id === "system.message.0")).toMatchObject({
      lane: "system",
      retention: "exact",
      content: "SYSTEM RULES",
    });
    expect(first.parts.find((part) => part.id === "system.tool_schemas")).toMatchObject({
      lane: "system",
      retention: "exact",
    });
    expect(first.parts.find((part) => part.id === "session.temporal.seq.1")).toMatchObject({
      retention: "summarizable",
      sourceRefs: ["seq:1"],
    });
    expect(first.parts.find((part) => part.id === "session.temporal.seq.3")).toMatchObject({
      retention: "exact",
      sourceRefs: ["seq:3"],
    });
    expect(first.parts.find((part) => part.id === "work.run.work_state")).toMatchObject({
      retention: "exact",
    });
    expect(first.parts.find((part) => part.id === "work.current")?.sourceRefs).toContain("seq:3");
  });

  it("removes duplicate identities and expired or malformed observations deterministically", () => {
    const state = promptState();
    state.context.temporal.recent.unshift({
      kind: "user",
      seq: 1,
      timestamp: "2026-07-19T00:00:00.000Z",
      content: "Duplicate sequence",
    });
    state.context.observations.inventory = [
      { observationId: "OBS-1", preview: "valid", expiresAt: "2026-07-22T00:00:00.000Z" },
      { observationId: "OBS-1", preview: "duplicate", expiresAt: "2026-07-22T00:00:00.000Z" },
      { observationId: "OBS-2", preview: "expired", expiresAt: "2026-07-20T00:00:00.000Z" },
      { observationId: "OBS-3" },
    ] as never;

    const reduced = removeDuplicateAndInvalidContext(
      state,
      new Date("2026-07-21T00:00:00.000Z"),
    );

    expect(reduced.stateView.context.temporal.recent.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(reduced.stateView.context.observations.inventory).toEqual([
      expect.objectContaining({ observationId: "OBS-1", preview: "valid" }),
    ]);
    expect(reduced.removedDuplicateCount).toBe(2);
    expect(reduced.removedInvalidObservationCount).toBe(2);
  });
});

function promptState(): AgentPromptStateView {
  return {
    context: {
      temporal: {
        recent: [
          { kind: "user", seq: 1, timestamp: "2026-07-20T00:00:00.000Z", content: "Earlier request" },
          { kind: "assistant", seq: 2, timestamp: "2026-07-20T00:00:01.000Z", content: "Earlier reply" },
          { kind: "user", seq: 3, timestamp: "2026-07-20T00:00:02.000Z", content: "CURRENT", current: true },
        ],
      },
      current: { inputSeq: 3, runId: "RUN-1", routing: { status: "unbound" } },
      stream: { agentId: "local", scopeKey: "default", recentWork: [] },
      work: { candidates: [] },
      resources: { stream: [], ingress: [], activeWorkstream: [] },
      observations: { revision: "obs:1", inventory: [], discovery: [], evidence: [] },
      run: {
        workState: {
          status: "not_done",
          summary: "Continue safely.",
          verifiedFacts: [],
          evidence: [],
        },
      },
    },
  };
}
