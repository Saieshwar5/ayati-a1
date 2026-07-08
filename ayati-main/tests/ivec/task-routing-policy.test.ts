import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import type { AgentAction, AgentDecision } from "../../src/ivec/agent-runner/decision.js";
import {
  createRoutingAttemptState,
  deferredMutationToolNames,
  mutationTargetPathsForAction,
  shouldAutoBindActiveTaskArtifactMutation,
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

function activeTaskContext(): ContextEngineMachineContext {
  return {
    ...contextEngine({
      status: "active",
      ref: "refs/heads/task/W-1",
      workId: "W-1",
    }),
    task: {
      ref: "refs/heads/task/W-1",
      workId: "W-1",
      title: "Website",
      objective: "Update the website.",
      status: "in_progress",
      completed: [],
      open: [],
      blockers: [],
      facts: [],
      assets: [{
        assetId: "asset_1",
        role: "generated",
        kind: "file",
        name: "index.html",
        path: "src/index.html",
      }],
      recentRuns: [],
      recentCommits: [],
      recentEvidence: [],
    },
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
    const create = action("git_context_create_task_for_turn");
    expect(validateRoutingAttemptLimits(state(), create, false)).toBeUndefined();

    expect(validateRoutingAttemptLimits(state(), create, true)).toMatchObject({
      reason: "task_run_already_exists",
      tools: ["git_context_create_task_for_turn"],
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
      allowedTools: ["git_context_create_task_for_turn", "git_context_activate_task_for_turn"],
      calls: [
        { id: "call_1", tool: "git_context_create_task_for_turn", input: {} },
        { id: "call_2", tool: "git_context_activate_task_for_turn", input: {} },
      ],
      assertions: [],
    };

    expect(validateRoutingAttemptLimits(state(), multi, false)).toMatchObject({
      reason: "multiple_routing_tools",
      tools: ["git_context_create_task_for_turn", "git_context_activate_task_for_turn"],
    });
  });

  it("updates routing attempt state from successful and failed routing outputs", () => {
    const loopState = state();
    updateRoutingAttemptsFromActOutput(loopState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_create_task_for_turn",
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
      lastTool: "git_context_create_task_for_turn",
    });

    const failedState = state();
    updateRoutingAttemptsFromActOutput(failedState, {
      finalText: "",
      toolCalls: [{
        tool: "git_context_activate_task_for_turn",
        input: {},
        output: "",
        error: "missing task",
      }],
    }, { blocked: false });

    expect(failedState.routingAttempts).toMatchObject({
      successCount: 0,
      failureCount: 1,
      resolved: false,
      lastTool: "git_context_activate_task_for_turn",
      lastError: "missing task",
    });
  });

  it("detects deferred pre-task mutations and keeps routing actions out of deferred mutation", () => {
    expect(shouldDeferPreTaskMutation(state(), decision("write_file"), undefined)).toBe(true);
    expect(deferredMutationToolNames(action("write_file"))).toEqual(["write_file"]);
    expect(shouldDeferPreTaskMutation(state(), decision("git_context_create_task_for_turn"), undefined)).toBe(false);
    expect(shouldDeferPreTaskMutation(state({ runId: "R-1" }), decision("write_file"), { sessionId: "S-1", runId: "R-1" })).toBe(false);
  });

  it("auto-binds active-task artifact mutations only when every target belongs to the active task", () => {
    const loopState = state({
      harnessContext: createInitialHarnessContext({
        contextEngine: activeTaskContext(),
      }),
    });

    expect(shouldAutoBindActiveTaskArtifactMutation(loopState, decision("write_file", {
      path: "src/index.html",
    }))).toBe(true);

    expect(shouldAutoBindActiveTaskArtifactMutation(loopState, decision("write_file", {
      path: "src/other.html",
    }))).toBe(false);
  });

  it("extracts mutation targets from direct paths and array inputs", () => {
    const targets = mutationTargetPathsForAction({
      mode: "single",
      allowedTools: ["write_files"],
      assertions: [],
      calls: [{
        id: "call_1",
        tool: "write_files",
        input: {
          files: [
            "a.txt",
            { path: "b.txt" },
            { from: "old.txt", to: "new.txt" },
          ],
        },
      }],
    });

    expect(targets).toEqual(["a.txt", "b.txt", "old.txt", "new.txt"]);
  });

  it("detects file mutation tools on step summaries", () => {
    expect(stepUsesFileMutationTool(step("write_file", "success"))).toBe(true);
    expect(stepUsesFileMutationTool(step("read_file", "success"))).toBe(false);
  });
});
