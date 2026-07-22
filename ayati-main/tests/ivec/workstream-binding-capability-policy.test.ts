import { describe, expect, it } from "vitest";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  filterToolsByWorkstreamBinding,
  isDecisionAllowedByWorkstreamBinding,
  toolPhaseForWorkstreamBinding,
} from "../../src/ivec/agent-runner/workstream-binding-capability-policy.js";
import type { AgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

describe("workstream binding capability policy", () => {
  it("allows observation but keeps legacy resolution tools outside an unbound main loop", () => {
    const policy = deriveWorkstreamBindingCapabilityPolicy(state("unbound"));
    const visible = filterToolsByWorkstreamBinding(policy, [
      tool("read_files"),
      tool("search_in_files"),
      tool("write_files"),
      tool("git_context_inspect_resource"),
      tool("git_context_bind_resources"),
      tool("git_context_activate_workstream"),
      tool("git_context_create_workstream"),
    ]).map((entry) => entry.name);

    expect(policy).toMatchObject({ workstreamBound: false, routingAvailable: true });
    expect(toolPhaseForWorkstreamBinding(policy, visible.length)).toBe("routing");
    expect(visible).toEqual([
      "read_files",
      "search_in_files",
    ]);
  });

  it("suppresses routing controls for clearly conversational input", () => {
    const current = state(undefined, "Thanks, that answers my question.");
    const policy = deriveWorkstreamBindingCapabilityPolicy(current);

    expect(policy.routingSuppressed).toBe(true);
    expect(policy.routingAvailable).toBe(false);
    expect(filterToolsByWorkstreamBinding(policy, [
      tool("read_files"),
      tool("git_context_create_workstream"),
    ]).map((entry) => entry.name)).toEqual(["read_files"]);
  });

  it("allows normal workstream capabilities and hides routing after binding", () => {
    const policy = deriveWorkstreamBindingCapabilityPolicy(state("bound"));
    const visible = filterToolsByWorkstreamBinding(policy, [
      tool("read_files"),
      tool("write_files"),
      tool("git_context_inspect_resource"),
      tool("git_context_bind_resources"),
      tool("git_context_create_workstream"),
    ]).map((entry) => entry.name);

    expect(policy.workstreamBound).toBe(true);
    expect(policy.routingAvailable).toBe(false);
    expect(visible).toEqual([
      "read_files",
      "write_files",
      "git_context_bind_resources",
    ]);
  });

  it("fails closed for tools without a known taxonomy even after binding", () => {
    const policy = deriveWorkstreamBindingCapabilityPolicy(state("bound"));

    expect(filterToolsByWorkstreamBinding(policy, [
      tool("read_files"),
      tool("unclassified_tool"),
    ]).map((entry) => entry.name)).toEqual(["read_files"]);
    expect(isDecisionAllowedByWorkstreamBinding(
      policy,
      decision("unclassified_tool"),
    )).toBe(false);
  });

  it("rejects mutation decisions before binding and accepts them afterward", () => {
    const mutation = decision("write_files");

    expect(isDecisionAllowedByWorkstreamBinding(
      deriveWorkstreamBindingCapabilityPolicy(state("unbound")),
      mutation,
    )).toBe(false);
    expect(isDecisionAllowedByWorkstreamBinding(
      deriveWorkstreamBindingCapabilityPolicy(state("bound")),
      mutation,
    )).toBe(true);
  });

});

function state(
  routingStatus?: "unbound" | "bound" | "clarifying",
  userMessage = "Create a file",
): LoopState {
  const contextEngine = contextEngineFixture({ message: userMessage });
  const status = routingStatus ?? "unbound";
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
    runPath: "",
    failureHistory: [],
    harnessContext: {
      personalMemorySnapshot: "",
      contextEngine: {
        ...contextEngine,
        current: {
          ...contextEngine.current,
          routing: {
            status,
            ...(status === "bound" ? { workstreamId: "W-1", requestId: "REQ-1" } : {}),
          },
        },
        focus: status === "bound"
          ? { status: "active", ref: "refs/heads/main", workstreamId: "W-1" }
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
