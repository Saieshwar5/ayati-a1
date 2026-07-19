import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import type { AgentAction } from "../../src/ivec/agent-runner/decision.js";
import {
  createRoutingAttemptState,
  stepUsesFileMutationTool,
  updateRoutingAttemptsFromActOutput,
  validateRoutingAttemptLimits,
} from "../../src/ivec/agent-runner/workstream-routing-policy.js";

function state(input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "R-1",
    currentSeq: 1,
    userMessage: "create a file",
    workState: {
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 1,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    routingAttempts: createRoutingAttemptState(),
    runPath: "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(input.harnessContext ? {
      contextEngine: input.harnessContext.contextEngine,
      personalMemorySnapshot: input.harnessContext.personalMemorySnapshot,
    } : undefined),
    ...input,
  };
}

function contextEngine(focus: ContextEngineMachineContext["focus"]): ContextEngineMachineContext {
  return {
    session: {
      meta: {
        sessionId: "S-1",
        resourceCount: 0,
      },
      conversationTail: [],
      activityTail: [],
    },
    focus,
  };
}

function action(tool: string, input: Record<string, unknown> = {}): AgentAction {
  return {
    mode: "single",
    allowedTools: [tool],
    calls: [{
      id: "call_1",
      tool,
      input,
      dependsOn: [],
      purpose: `Use ${tool}`,
    }],
    assertions: [],
  };
}

function step(tool: string, outcome: "success" | "failed"): StepSummary {
  return {
    step: outcome === "success" ? 2 : 1,
    outcome,
    summary: `${tool} ${outcome}`,
    newFacts: [],
    artifacts: [],
    toolsUsed: [tool],
    toolSuccessCount: outcome === "success" ? 1 : 0,
    toolFailureCount: outcome === "failed" ? 1 : 0,
  };
}

describe("workstream routing policy", () => {
  it("blocks routing tools after binding, after success, and after retry limit", () => {
    const create = action("git_context_create_workstream");
    expect(validateRoutingAttemptLimits(state(), create, false)).toBeUndefined();

    expect(validateRoutingAttemptLimits(state(), create, true)).toMatchObject({
      reason: "workstream_binding_already_exists",
      tools: ["git_context_create_workstream"],
    });

    expect(validateRoutingAttemptLimits(state({
      routingAttempts: {
        ...createRoutingAttemptState(),
        successCount: 1,
        resolved: true,
      },
    }), create, false)).toMatchObject({
      reason: "routing_already_resolved",
    });

    expect(validateRoutingAttemptLimits(state({
      routingAttempts: {
        ...createRoutingAttemptState(),
        failureCount: 2,
      },
    }), create, false)).toMatchObject({
      reason: "routing_retry_limit_reached",
    });
  });

  it("allows exactly one routing control per routing decision", () => {
    const multi: AgentAction = {
      mode: "sequential",
      allowedTools: ["git_context_create_workstream", "git_context_activate_workstream"],
      calls: [
        { id: "call_1", tool: "git_context_create_workstream", input: {}, dependsOn: [], purpose: "Create workstream" },
        { id: "call_2", tool: "git_context_activate_workstream", input: {}, dependsOn: [], purpose: "Activate workstream" },
      ],
      assertions: [],
    };

    expect(validateRoutingAttemptLimits(state(), multi, false)).toMatchObject({
      reason: "multiple_routing_tools",
      tools: ["git_context_create_workstream", "git_context_activate_workstream"],
    });
  });

  it("updates routing attempt state from successful and failed routing outputs", () => {
    const loopState = state();
    updateRoutingAttemptsFromActOutput(loopState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_create_workstream",
        input: {},
        output: "",
        result: {
          ok: true,
          output: "",
          structuredContent: { status: "ready" },
        },
      }],
    }, { blocked: false });

    expect(loopState.routingAttempts).toMatchObject({
      successCount: 1,
      failureCount: 0,
      resolved: true,
      lastTool: "git_context_create_workstream",
    });

    const failedState = state();
    updateRoutingAttemptsFromActOutput(failedState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_activate_workstream",
        input: {},
        output: "",
        error: "missing workstream",
      }],
    }, { blocked: false });

    expect(failedState.routingAttempts).toMatchObject({
      successCount: 0,
      failureCount: 1,
      resolved: false,
      lastTool: "git_context_activate_workstream",
      lastError: "missing workstream",
    });
  });

  it("detects file mutation tools on step summaries", () => {
    expect(stepUsesFileMutationTool(step("write_files", "success"))).toBe(true);
    expect(stepUsesFileMutationTool(step("read_files", "success"))).toBe(false);
  });
});
