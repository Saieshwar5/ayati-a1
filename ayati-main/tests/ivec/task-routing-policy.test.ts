import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import type { AgentAction, AgentDecision } from "../../src/ivec/agent-runner/decision.js";
import {
  createRoutingAttemptState,
  deferredMutationToolNames,
  shouldDeferPreTaskMutation,
  stepUsesFileMutationTool,
  updateRoutingAttemptsFromActOutput,
  validateRoutingAttemptLimits,
} from "../../src/ivec/agent-runner/task-routing-policy.js";

function state(input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "",
    currentSeq: 1,
    runClass: "interaction",
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
        assetCount: 0,
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
    }],
    assertions: [],
  };
}

function decision(tool: string, input: Record<string, unknown> = {}): AgentDecision {
  return {
    kind: "act",
    action: action(tool, input),
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

describe("task routing policy", () => {
  it("blocks routing tools after a task run exists, after success, and after retry limit", () => {
    const create = action("git_context_create_task");
    expect(validateRoutingAttemptLimits(state(), create, false)).toBeUndefined();

    expect(validateRoutingAttemptLimits(state(), create, true)).toMatchObject({
      reason: "task_run_already_exists",
      tools: ["git_context_create_task"],
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

  it("allows exactly one routing mutation tool per routing decision", () => {
    const multi: AgentAction = {
      mode: "sequential",
      allowedTools: ["git_context_create_task", "git_context_activate_task"],
      calls: [
        { id: "call_1", tool: "git_context_create_task", input: {} },
        { id: "call_2", tool: "git_context_activate_task", input: {} },
      ],
      assertions: [],
    };

    expect(validateRoutingAttemptLimits(state(), multi, false)).toMatchObject({
      reason: "multiple_routing_tools",
      tools: ["git_context_create_task", "git_context_activate_task"],
    });
  });

  it("updates routing attempt state from successful and failed routing outputs", () => {
    const loopState = state();
    updateRoutingAttemptsFromActOutput(loopState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_create_task",
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
      lastTool: "git_context_create_task",
    });

    const failedState = state();
    updateRoutingAttemptsFromActOutput(failedState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_activate_task",
        input: {},
        output: "",
        error: "missing task",
      }],
    }, { blocked: false });

    expect(failedState.routingAttempts).toMatchObject({
      successCount: 0,
      failureCount: 1,
      resolved: false,
      lastTool: "git_context_activate_task",
      lastError: "missing task",
    });
  });

  it("detects deferred pre-task mutations and keeps routing actions out of deferred mutation", () => {
    expect(shouldDeferPreTaskMutation(state(), decision("write_files"), undefined)).toBe(true);
    expect(deferredMutationToolNames(action("write_files"))).toEqual(["write_files"]);
    expect(shouldDeferPreTaskMutation(state(), decision("git_context_create_task"), undefined)).toBe(false);
    expect(shouldDeferPreTaskMutation(state({ runId: "R-1" }), decision("write_files"), { sessionId: "S-1", runId: "R-1" })).toBe(false);
  });

  it("detects file mutation tools on step summaries", () => {
    expect(stepUsesFileMutationTool(step("write_files", "success"))).toBe(true);
    expect(stepUsesFileMutationTool(step("read_files", "success"))).toBe(false);
  });
});
