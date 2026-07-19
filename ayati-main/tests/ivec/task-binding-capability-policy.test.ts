import { describe, expect, it } from "vitest";
import {
  deriveTaskBindingCapabilityPolicy,
  filterToolsByTaskBinding,
  isDecisionAllowedByTaskBinding,
  toolPhaseForTaskBinding,
} from "../../src/ivec/agent-runner/task-binding-capability-policy.js";
import type { AgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";

describe("task binding capability policy", () => {
  it("allows observation and routing controls while an existing run is unbound", () => {
    const policy = deriveTaskBindingCapabilityPolicy(state("unbound"));
    const visible = filterToolsByTaskBinding(policy, [
      tool("read_files"),
      tool("search_in_files"),
      tool("write_files"),
      tool("git_context_activate_task"),
      tool("git_context_create_task"),
    ]).map((entry) => entry.name);

    expect(policy).toMatchObject({ taskBound: false, routingAvailable: true });
    expect(toolPhaseForTaskBinding(policy, visible.length)).toBe("routing");
    expect(visible).toEqual([
      "read_files",
      "search_in_files",
      "git_context_activate_task",
      "git_context_create_task",
    ]);
  });

  it("suppresses routing controls for clearly conversational input", () => {
    const current = state(undefined, "Thanks, that answers my question.");
    const policy = deriveTaskBindingCapabilityPolicy(current);

    expect(policy.routingSuppressed).toBe(true);
    expect(policy.routingAvailable).toBe(false);
    expect(filterToolsByTaskBinding(policy, [
      tool("read_files"),
      tool("git_context_create_task"),
    ]).map((entry) => entry.name)).toEqual(["read_files"]);
  });

  it("allows normal task capabilities and hides routing after binding", () => {
    const policy = deriveTaskBindingCapabilityPolicy(state("bound"));
    const visible = filterToolsByTaskBinding(policy, [
      tool("read_files"),
      tool("write_files"),
      tool("git_context_create_task"),
    ]).map((entry) => entry.name);

    expect(policy.taskBound).toBe(true);
    expect(policy.routingAvailable).toBe(false);
    expect(visible).toEqual(["read_files", "write_files"]);
  });

  it("fails closed for tools without a known taxonomy even after binding", () => {
    const policy = deriveTaskBindingCapabilityPolicy(state("bound"));

    expect(filterToolsByTaskBinding(policy, [
      tool("read_files"),
      tool("unclassified_tool"),
    ]).map((entry) => entry.name)).toEqual(["read_files"]);
    expect(isDecisionAllowedByTaskBinding(
      policy,
      decision("unclassified_tool"),
    )).toBe(false);
  });

  it("rejects mutation decisions before binding and accepts them afterward", () => {
    const mutation = decision("write_files");

    expect(isDecisionAllowedByTaskBinding(
      deriveTaskBindingCapabilityPolicy(state("unbound")),
      mutation,
    )).toBe(false);
    expect(isDecisionAllowedByTaskBinding(
      deriveTaskBindingCapabilityPolicy(state("bound")),
      mutation,
    )).toBe(true);
  });

  it("closes routing after the failure limit without exposing counters to prompt context", () => {
    const current = state("unbound");
    current.routingAttempts = {
      successCount: 0,
      failureCount: 2,
      maxFailures: 2,
      resolved: false,
    };

    const policy = deriveTaskBindingCapabilityPolicy(current);
    expect(policy).toMatchObject({
      routingFailureLimitReached: true,
      routingAvailable: false,
    });
  });
});

function state(
  routingStatus?: "unbound" | "bound" | "clarifying",
  userMessage = "Create a file",
): LoopState {
  return {
    runId: "R-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage,
    workState: {
      status: "not_done",
      summary: "",
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
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
    harnessContext: {
      personalMemorySnapshot: "",
      contextEngine: {
        session: {
          meta: { sessionId: "S-1", assetCount: 0 },
          conversationTail: [],
          activityTail: [],
        },
        ...(routingStatus ? {
          pendingTurn: {
            fromSeq: 1,
            toSeq: 1,
            text: userMessage,
            at: "2026-07-19T10:00:00.000Z",
            routingStatus,
            runId: "R-1",
          },
        } : {}),
        focus: routingStatus === "bound"
          ? { status: "active", ref: "refs/heads/task/T-1", workId: "T-1" }
          : { status: "none" },
      },
    },
  };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    async execute() {
      return { ok: true, output: "" };
    },
  };
}

function decision(toolName: string): AgentDecision {
  return {
    kind: "act",
    action: {
      mode: "single",
      calls: [{
        id: "call-1",
        tool: toolName,
        input: {},
        dependsOn: [],
        purpose: "Perform the requested work",
      }],
      allowedTools: [toolName],
      assertions: [],
    },
  };
}
