import { describe, expect, it } from "vitest";
import type { PromptRunToolCallContext } from "../../src/ivec/agent-runner/run-tool-call-context.js";
import { planToolContextProjection } from "../../src/ivec/agent-runner/tool-context-projection-planner.js";

describe("tool context projection planner", () => {
  it("keeps every tool call full below the soft limit", () => {
    const plan = planToolContextProjection({
      calls: calls(12),
      candidateInputTokens: 69_999,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
    });

    expect(plan.triggered).toBe(false);
    expect(plan.requiredSavingsTokens).toBe(0);
    expect(plan.estimatedSavingsTokens).toBe(0);
    expect(plan.canReachTarget).toBe(true);
    expect(plan.calls).toHaveLength(12);
    expect(plan.calls.every((call) => call.mode === "full")).toBe(true);
    expect(plan.calls.every((call) => call.reason === "below_soft_limit")).toBe(true);
  });

  it("projects only enough older calls while keeping the latest six full", () => {
    const plan = planToolContextProjection({
      calls: calls(10, 32_000),
      candidateInputTokens: 80_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
    });

    expect(plan.triggered).toBe(true);
    expect(plan.requiredSavingsTokens).toBe(20_000);
    expect(plan.projectedInputTokens).toBeLessThanOrEqual(60_000);
    expect(plan.canReachTarget).toBe(true);
    expect(plan.calls.slice(-6).every((call) => call.mode === "full")).toBe(true);
    expect(plan.calls.slice(-6).every((call) => call.reason === "latest_six")).toBe(true);
    expect(plan.calls.slice(0, 4).some((call) => call.mode !== "full")).toBe(true);
    expect(plan.calls.slice(0, 4).some((call) => call.projectorId === "filesystem_read_v1")).toBe(true);
    expect(plan.calls.slice(0, 4).some((call) => call.reason === "target_reached")).toBe(true);
    expect(plan.projectedCalls.slice(-6).every((call) => call.mode === "full")).toBe(true);
  });

  it("pins older failures and calls without a recovery reference", () => {
    const toolCalls = calls(9, 20_000);
    toolCalls[0] = { ...toolCalls[0]!, status: "failed", error: "failed" };
    toolCalls[1] = { ...toolCalls[1]!, stepRef: undefined, evidenceRef: undefined };

    const plan = planToolContextProjection({
      calls: toolCalls,
      candidateInputTokens: 85_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
    });

    expect(plan.calls[0]).toMatchObject({ mode: "full", reason: "failed_call" });
    expect(plan.calls[1]).toMatchObject({ mode: "full", reason: "not_recoverable" });
  });
});

function calls(count: number, outputChars = 100): PromptRunToolCallContext[] {
  return Array.from({ length: count }, (_, index) => ({
    step: index + 1,
    callId: `call-${index + 1}`,
    tool: "read_files",
    input: { path: `src/file-${index + 1}.ts` },
    status: "success" as const,
    retention: index === 0 ? "evidence_only" as const : "next_step" as const,
    mode: "full" as const,
    output: "x".repeat(outputChars),
    stepRef: { runId: "run-1", step: index + 1, callId: `call-${index + 1}` },
  }));
}
