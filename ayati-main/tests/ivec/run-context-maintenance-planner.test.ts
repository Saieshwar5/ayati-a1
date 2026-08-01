import { describe, expect, it } from "vitest";
import type { PromptRunToolCallContext } from "../../src/ivec/agent-runner/run-tool-call-context.js";
import type { RunContextMaintenanceSelection } from "../../src/ivec/agent-runner/run-context-maintenance-contracts.js";
import {
  applyRunContextMaintenanceSelection,
  buildRunContextMaintenancePlan,
  hasRunContextMaintenanceOpportunity,
} from "../../src/ivec/agent-runner/run-context-maintenance-planner.js";

describe("run context maintenance planner", () => {
  it("protects recent, failed, WorkState-referenced, and unknown calls", () => {
    const toolCalls = calls(11, 12_000);
    toolCalls[0] = { ...toolCalls[0]!, tool: "custom_unknown_tool" };
    toolCalls[1] = { ...toolCalls[1]!, status: "failed", error: "read failed" };
    const plan = buildRunContextMaintenancePlan({
      calls: toolCalls,
      workState: {
        status: "in_progress",
        summary: "Continue from the selected source.",
        plan: [],
        importantContext: [{
          kind: "finding",
          value: "The third call contains the selected source.",
          ref: "call:call-3",
        }],
      },
      workStateRevision: 2,
      candidateInputTokens: 80_000,
      recoveryTargetTokens: 60_000,
    });

    expect(plan.entries[0]).toMatchObject({
      mandatoryExact: true,
      mandatoryReason: "unknown_tool",
      policy: "exact_only",
    });
    expect(plan.entries[1]).toMatchObject({
      mandatoryExact: true,
      mandatoryReason: "failed_call",
    });
    expect(plan.entries[2]).toMatchObject({
      mandatoryExact: true,
      mandatoryReason: "workstate_reference",
    });
    expect(plan.entries.slice(-6).every((entry) => (
      entry.mandatoryReason === "latest_six"
    ))).toBe(true);
    expect(plan.inventory.map((entry) => entry.ref)).toEqual([
      "call:call-4",
      "call:call-5",
    ]);
  });

  it("combines bounded model exceptions with deterministic default projection", () => {
    const toolCalls = calls(10, 24_000);
    const plan = buildRunContextMaintenancePlan({
      calls: toolCalls,
      workState: emptyWorkState(),
      workStateRevision: 0,
      candidateInputTokens: 88_000,
      recoveryTargetTokens: 60_000,
    });
    const selection = selectionFor(plan, {
      keepExactRefs: ["call:call-1"],
      keepCompactRefs: ["call:call-2"],
      releaseRefs: ["call:call-3"],
    });
    const applied = applyRunContextMaintenanceSelection({
      plan,
      calls: toolCalls,
      selection,
      persistedWorkStateRevision: 1,
      iteration: 9,
    });

    expect(applied.projectedCalls[0]?.mode).toBe("full");
    expect(applied.projectedCalls[1]?.mode).toBe("preview");
    expect(applied.projectedCalls[2]?.mode).toBe("reference");
    expect(applied.projectedCalls.slice(-6).every((call) => call.mode === "full"))
      .toBe(true);
    expect(applied.overlay.modesByRef["call:call-1"]).toBeUndefined();
    expect(applied.overlay.modesByRef["call:call-3"]).toBe("reference");
    expect(applied.overlay.workStateRevision).toBe(1);
    expect(applied.overlay.estimatedSavingsTokens).toBeGreaterThan(0);
  });

  it("lets known unspecialized tools become references but keeps unknown tools exact", () => {
    const toolCalls = calls(9, 10_000);
    toolCalls[0] = { ...toolCalls[0]!, tool: "calculator", input: { expression: "2 + 2" } };
    toolCalls[1] = { ...toolCalls[1]!, tool: "custom_unknown_tool" };
    const plan = buildRunContextMaintenancePlan({
      calls: toolCalls,
      workState: emptyWorkState(),
      workStateRevision: 0,
      candidateInputTokens: 75_000,
      recoveryTargetTokens: 60_000,
    });

    expect(plan.entries[0]).toMatchObject({ policy: "referenceable", mandatoryExact: false });
    expect(plan.inventory.map((entry) => entry.ref)).toContain("call:call-1");
    expect(plan.entries[1]).toMatchObject({
      policy: "exact_only",
      mandatoryExact: true,
      mandatoryReason: "unknown_tool",
    });
    const applied = applyRunContextMaintenanceSelection({
      plan,
      calls: toolCalls,
      selection: selectionFor(plan, { releaseRefs: ["call:call-1"] }),
      persistedWorkStateRevision: 1,
      iteration: 3,
    });
    expect(applied.projectedCalls[0]?.mode).toBe("reference");
    expect(applied.projectedCalls[1]?.mode).toBe("full");
  });

  it("rejects a stale maintenance plan and does not retrigger for the same source", () => {
    const toolCalls = calls(9, 12_000);
    const plan = buildRunContextMaintenancePlan({
      calls: toolCalls,
      workState: emptyWorkState(),
      workStateRevision: 0,
      candidateInputTokens: 75_000,
      recoveryTargetTokens: 60_000,
    });
    const applied = applyRunContextMaintenanceSelection({
      plan,
      calls: toolCalls,
      selection: selectionFor(plan),
      persistedWorkStateRevision: 1,
      iteration: 3,
    });

    expect(hasRunContextMaintenanceOpportunity(plan, applied.overlay)).toBe(false);
    expect(() => applyRunContextMaintenanceSelection({
      plan,
      calls: [...toolCalls, call(10, 12_000)],
      selection: selectionFor(plan),
      persistedWorkStateRevision: 1,
      iteration: 4,
    })).toThrow("tool journal changed");
  });
});

function calls(count: number, outputChars: number): PromptRunToolCallContext[] {
  return Array.from({ length: count }, (_, index) => call(index + 1, outputChars));
}

function call(step: number, outputChars: number): PromptRunToolCallContext {
  return {
    step,
    callId: `call-${step}`,
    tool: "read_files",
    purpose: `Read source ${step}.`,
    input: { files: [{ path: `/workspace/source-${step}.txt` }] },
    status: "success",
    retention: "next_step",
    mode: "full",
    output: "x".repeat(outputChars),
    stepRef: { step, callId: `call-${step}` },
    verificationStatus: "passed",
  };
}

function emptyWorkState() {
  return {
    status: "in_progress" as const,
    summary: "Run started.",
    plan: [],
    importantContext: [],
  };
}

function selectionFor(
  plan: ReturnType<typeof buildRunContextMaintenancePlan>,
  overrides: Partial<RunContextMaintenanceSelection> = {},
): RunContextMaintenanceSelection {
  return {
    maintenanceId: plan.maintenanceId,
    expectedWorkStateRevision: plan.expectedWorkStateRevision,
    workState: {
      reason: "context_pressure",
      summary: "The run has verified prior work and remains in progress.",
      plan: [],
      importantContext: [],
      nextAction: "Continue the current task.",
    },
    keepExactRefs: [],
    keepCompactRefs: [],
    releaseRefs: [],
    ...overrides,
  };
}
