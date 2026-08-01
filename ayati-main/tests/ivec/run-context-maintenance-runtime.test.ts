import { describe, expect, it, vi } from "vitest";
import { buildInitialState } from "../../src/ivec/agent-runner/runner-state.js";
import {
  enterRunContextMaintenance,
  handleRunContextMaintenanceDecision,
  planRunContextMaintenance,
} from "../../src/ivec/agent-runner/run-context-maintenance-runtime.js";
import type { AgentLoopDeps, LoopState } from "../../src/ivec/types.js";
import { DEFAULT_LOOP_CONFIG } from "../../src/ivec/types.js";

describe("run context maintenance runtime", () => {
  it("checkpoints WorkState, adopts a prompt-only overlay, and restores the exact task mode", async () => {
    const state = pressuredState();
    const plan = planRunContextMaintenance(state);
    expect(plan).toBeDefined();
    enterRunContextMaintenance(state, plan!);
    const checkpointWorkState = vi.fn(async (input) => ({
      runtime: {
        revision: input.runtime.revision + 1,
        afterStep: input.afterStep,
        updateReason: input.reason,
        updatedAt: input.at,
      },
    }));
    const result = await handleRunContextMaintenanceDecision({
      state,
      selection: {
        maintenanceId: plan!.maintenanceId,
        expectedWorkStateRevision: 0,
        workState: {
          reason: "context_pressure",
          summary: "The older source reads are verified and implementation remains.",
          plan: [{ id: "implement", task: "Implement the requested change.", status: "active" }],
          importantContext: [],
          nextAction: "Implement the requested change.",
        },
        keepExactRefs: [],
        keepCompactRefs: [],
        releaseRefs: [],
      },
      checkpointWorkState,
      afterStep: 9,
      at: "2026-08-01T12:00:00.000Z",
    });

    expect(result).toMatchObject({ status: "applied", targetReached: true });
    expect(checkpointWorkState).toHaveBeenCalledOnce();
    expect(state.workStateRuntime).toMatchObject({
      revision: 1,
      afterStep: 9,
      updateReason: "context_pressure",
    });
    expect(state.workState).toMatchObject({
      status: "in_progress",
      summary: "The older source reads are verified and implementation remains.",
    });
    expect(state.runContextProjection?.revision).toBe(1);
    expect(state.runContextProjection?.sourceThroughStep).toBe(10);
    expect(state.virtualMode).toMatchObject({
      active: "execute",
      purpose: "Continue implementation.",
      capabilities: ["file:write"],
      targets: ["/workspace/site"],
    });
    expect(state.runContextMaintenanceBudgetCredits).toBe(2);
  });

  it("allows one retry for a stale model selection without changing WorkState", async () => {
    const state = pressuredState();
    const plan = planRunContextMaintenance(state)!;
    enterRunContextMaintenance(state, plan);
    const checkpointWorkState = vi.fn();
    const result = await handleRunContextMaintenanceDecision({
      state,
      selection: {
        maintenanceId: "RUNCTX-STALE",
        expectedWorkStateRevision: 0,
        workState: {
          reason: "context_pressure",
          summary: "Do not persist this stale selection.",
          plan: [],
          importantContext: [],
        },
        keepExactRefs: [],
        keepCompactRefs: [],
        releaseRefs: [],
      },
      checkpointWorkState: checkpointWorkState as NonNullable<AgentLoopDeps["checkpointWorkState"]>,
      afterStep: 9,
      at: "2026-08-01T12:00:00.000Z",
    });

    expect(result).toMatchObject({ status: "retry", attempt: 1 });
    expect(checkpointWorkState).not.toHaveBeenCalled();
    expect(state.workStateRuntime.revision).toBe(0);
    expect(state.virtualMode.active).toBe("run.maintain");
  });

  it("uses the safe fallback after the second invalid selection without double-counting its turn", async () => {
    const state = pressuredState();
    const plan = planRunContextMaintenance(state)!;
    enterRunContextMaintenance(state, plan);
    const checkpointWorkState = vi.fn(async (input) => ({
      runtime: {
        revision: input.runtime.revision + 1,
        afterStep: input.afterStep,
        updateReason: input.reason,
        updatedAt: input.at,
      },
    }));
    const staleSelection = {
      maintenanceId: "RUNCTX-STALE",
      expectedWorkStateRevision: 0,
      workState: {
        reason: "context_pressure" as const,
        summary: "This stale selection must not be persisted.",
        plan: [],
        importantContext: [],
      },
      keepExactRefs: [],
      keepCompactRefs: [],
      releaseRefs: [],
    };

    const first = await handleRunContextMaintenanceDecision({
      state,
      selection: staleSelection,
      checkpointWorkState,
      afterStep: 9,
      at: "2026-08-01T12:00:00.000Z",
    });
    const second = await handleRunContextMaintenanceDecision({
      state,
      selection: staleSelection,
      checkpointWorkState,
      afterStep: 9,
      at: "2026-08-01T12:00:01.000Z",
    });

    expect(first).toMatchObject({ status: "retry", attempt: 1 });
    expect(second).toMatchObject({
      status: "applied",
      usedFallback: true,
      priorRejection: expect.stringContaining("stale"),
    });
    expect(checkpointWorkState).toHaveBeenCalledOnce();
    expect(state.virtualMode.active).toBe("execute");
    expect(state.workStateRuntime.revision).toBe(1);
    expect(state.runContextMaintenanceBudgetCredits).toBe(3);
  });
});

function pressuredState(): LoopState {
  const deps = {
    provider: {} as AgentLoopDeps["provider"],
    toolDefinitions: [],
    runHandle: { runId: "RUN-1", streamId: "S-1", triggerSeq: 1 },
    clientId: "c1",
    dataDir: "/tmp/ayati-run-maintain-test",
  } satisfies AgentLoopDeps;
  const state = buildInitialState(
    deps,
    DEFAULT_LOOP_CONFIG,
    { sessionId: "S-1", seq: 1 },
    deps.runHandle,
  );
  state.virtualMode = {
    active: "execute",
    revision: 3,
    operational: true,
    purpose: "Continue implementation.",
    capabilities: ["file:write"],
    targets: ["/workspace/site"],
    mutationScopes: ["/workspace/site"],
    enteredAtIteration: 3,
  };
  state.iteration = 8;
  state.toolContext = {
    recent: [],
    toolCalls: Array.from({ length: 10 }, (_, index) => ({
      step: index + 1,
      callId: `call-${index + 1}`,
      tool: "read_files",
      purpose: `Read source ${index + 1}.`,
      input: { files: [{ path: `/workspace/source-${index + 1}.txt` }] },
      status: "success" as const,
      retention: "next_step" as const,
      output: "x".repeat(30_000),
      stepRef: {
        runId: "RUN-1",
        step: index + 1,
        callId: `call-${index + 1}`,
      },
      verificationPassed: true,
    })),
  };
  state.contextPressure = {
    mode: "tool_compact",
    softLimitBreachCount: 1,
    unresolvedPressureStreak: 0,
    successfulRecoveryCount: 0,
    admissionRejectionCount: 0,
    peakCandidateInputTokens: 90_000,
    latestReceipt: {
      schemaVersion: 2,
      decisionAttempt: 1,
      mode: "tool_compact",
      provider: "test",
      model: "test",
      candidateInputTokens: 90_000,
      finalInputTokens: 70_000,
      preparationInputTokens: 55_000,
      recoveryTargetTokens: 60_000,
      softInputTokens: 70_000,
      hardInputTokens: 100_000,
      admissionLimitTokens: 92_000,
      forcedBarrierTokens: 85_000,
      nextDecisionReserveTokens: 8_000,
      softLimitExceeded: true,
      hardLimitExceeded: false,
      admitted: true,
      countSource: "provider_count",
      toolProjectionPolicy: "enforce",
      targetReached: false,
      needsEscalation: true,
      transformations: [],
    },
  };
  return state;
}
