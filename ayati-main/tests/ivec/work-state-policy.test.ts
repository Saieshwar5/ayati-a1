import { describe, expect, it } from "vitest";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary, WorkState } from "../../src/ivec/types.js";
import type { AgentAction } from "../../src/ivec/agent-runner/decision.js";
import {
  applyAgentWorkStateUpdate,
  canCompleteLocallyAfterAction,
  createFailureRecordFromWorkStateUpdate,
  isWorkStateUpdateToolAvailable,
} from "../../src/ivec/agent-runner/work-state-policy.js";

function workState(input: Partial<WorkState> = {}): WorkState {
  return {
    status: "not_done",
    summary: "",
    verifiedFacts: [],
    evidence: [],
    ...input,
  };
}

function state(input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "R-1",
    currentSeq: 1,
    runClass: "task",
    userMessage: "update the html file",
    workState: workState(),
    status: "running",
    finalOutput: "",
    iteration: 1,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    routingAttempts: {
      successCount: 0,
      failureCount: 0,
      maxFailures: 2,
      resolved: false,
    },
    runPath: "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(),
    ...input,
  };
}

function step(tool: string, outcome: "success" | "failed", stepNumber = 1): StepSummary {
  return {
    step: stepNumber,
    outcome,
    summary: `${tool} ${outcome}`,
    newFacts: [],
    artifacts: [],
    toolsUsed: [tool],
    toolSuccessCount: outcome === "success" ? 1 : 0,
    toolFailureCount: outcome === "failed" ? 1 : 0,
  };
}

function action(tool: string, completion = true): AgentAction {
  return {
    mode: "single",
    allowedTools: [tool],
    calls: [{
      id: "call_1",
      tool,
      input: {},
    }],
    assertions: [],
    ...(completion ? { completion: { intent: "completion_candidate" } } : {}),
  };
}

describe("work state policy", () => {
  it("exposes work-state updates only for active not-done task runs", () => {
    expect(isWorkStateUpdateToolAvailable(state(), undefined)).toBe(true);
    expect(isWorkStateUpdateToolAvailable(state({
      runId: "",
      runClass: "interaction",
    }), undefined)).toBe(false);
    expect(isWorkStateUpdateToolAvailable(state({
      workState: workState({ status: "done" }),
    }), undefined)).toBe(false);
  });

  it("rejects done updates without evidence or with incompatible fields", () => {
    const noEvidence = state();
    expect(applyAgentWorkStateUpdate(noEvidence, {
      status: "done",
      summary: "Done.",
    })).toEqual({
      accepted: false,
      reason: "Cannot mark work done without prior successful tool evidence, verified facts, evidence, or artifacts.",
    });

    const withInput = state({
      completedSteps: [step("write_files", "success")],
    });
    expect(applyAgentWorkStateUpdate(withInput, {
      status: "done",
      summary: "Done.",
      userInputNeeded: "Confirm filename.",
    })).toEqual({
      accepted: false,
      reason: "Done work state cannot also require user input.",
    });

    const withBlocker = state({
      completedSteps: [step("write_files", "success")],
    });
    expect(applyAgentWorkStateUpdate(withBlocker, {
      status: "done",
      summary: "Done.",
      blockers: ["Missing token"],
    })).toEqual({
      accepted: false,
      reason: "Done work state cannot include blockers.",
    });
  });

  it("accepts done updates with valid completion evidence", () => {
    const loopState = state({
      workState: workState({
        openWork: ["finish"],
        blockers: ["old blocker"],
      }),
      completedSteps: [step("write_files", "success")],
    });

    expect(applyAgentWorkStateUpdate(loopState, {
      status: "done",
      summary: "File updated.",
    })).toEqual({ accepted: true });
    expect(loopState.workState).toMatchObject({
      status: "done",
      summary: "File updated.",
      openWork: [],
      blockers: [],
    });
    expect(loopState.workState.userInputNeeded).toBeUndefined();
  });

  it("validates blocked and needs-user-input updates", () => {
    expect(applyAgentWorkStateUpdate(state(), {
      status: "blocked",
      summary: "Blocked.",
      blockers: [],
    })).toEqual({
      accepted: false,
      reason: "Blocked work state requires at least one blocker.",
    });

    const blocked = state();
    expect(applyAgentWorkStateUpdate(blocked, {
      status: "blocked",
      summary: "Blocked.",
      blockers: ["Need API key"],
      openWork: ["retry"],
    })).toEqual({ accepted: true });
    expect(blocked.workState).toMatchObject({
      status: "blocked",
      blockers: ["Need API key"],
      openWork: ["retry"],
    });

    expect(applyAgentWorkStateUpdate(state(), {
      status: "needs_user_input",
      summary: "Need input.",
    })).toEqual({
      accepted: false,
      reason: "Needs-user-input work state requires userInputNeeded.",
    });

    const needsInput = state();
    expect(applyAgentWorkStateUpdate(needsInput, {
      status: "needs_user_input",
      summary: "Need input.",
      userInputNeeded: "Which file should I update?",
      openWork: ["wait for user"],
    })).toEqual({ accepted: true });
    expect(needsInput.workState).toMatchObject({
      status: "needs_user_input",
      userInputNeeded: "Which file should I update?",
      nextStep: "Which file should I update?",
      blockers: [],
    });
  });

  it("applies not-done updates without requiring evidence", () => {
    const loopState = state();
    expect(applyAgentWorkStateUpdate(loopState, {
      status: "not_done",
      summary: "Still working.",
      openWork: ["read file"],
      blockers: ["none"],
      nextStep: "Read the file.",
    })).toEqual({ accepted: true });
    expect(loopState.workState).toMatchObject({
      status: "not_done",
      summary: "Still working.",
      openWork: ["read file"],
      blockers: ["none"],
      nextStep: "Read the file.",
    });
  });

  it("requires a successful file mutation before local completion for file requests", () => {
    const loopState = state({
      userMessage: "update the html file",
    });
    expect(canCompleteLocallyAfterAction(action("read_files"), step("read_files", "success"), workState(), loopState)).toBe(false);
    expect(canCompleteLocallyAfterAction(action("write_files"), step("write_files", "success"), workState(), loopState)).toBe(true);
    expect(canCompleteLocallyAfterAction(action("write_files"), step("write_files", "failed"), workState(), loopState)).toBe(false);
  });

  it("allows local completion for non-file requests after successful candidate actions", () => {
    const loopState = state({
      userMessage: "what is the first law of thermodynamics",
    });
    expect(canCompleteLocallyAfterAction(action("calculator"), step("calculator", "success"), workState(), loopState)).toBe(true);
    expect(canCompleteLocallyAfterAction(action("calculator", false), step("calculator", "success"), workState(), loopState)).toBe(false);
    expect(canCompleteLocallyAfterAction(action("calculator"), step("calculator", "success"), workState({
      blockers: ["Need context"],
    }), loopState)).toBe(false);
  });

  it("builds failure records for rejected work-state updates", () => {
    expect(createFailureRecordFromWorkStateUpdate(4, "No evidence")).toEqual({
      step: 4,
      failureType: "validation_error",
      reason: "No evidence",
      blockedTargets: ["update_work_state"],
    });
  });
});
