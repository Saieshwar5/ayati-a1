import { describe, expect, it } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import {
  buildRuntimeCapabilityPromptContext,
  detectRuntimeCapabilityMode,
  filterToolsForRuntimeMode,
  isDecisionAllowedInRuntimeMode,
} from "../../src/ivec/agent-runner/runtime-capability-mode.js";
import type { AgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function state(contextEngine: ContextEngineMachineContext, runId = ""): LoopState {
  return {
    runId,
    runClass: runId ? "task" : "interaction",
    userMessage: "create a text file",
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
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: runId ? `/tmp/${runId}` : "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext({ contextEngine }),
  };
}

function gitContext(focus: ContextEngineMachineContext["focus"]): ContextEngineMachineContext {
  return {
    session: {
      sessionId: "s1",
      conversationTail: [],
      activityTail: [],
      assetCount: 0,
    },
    focus,
  };
}

function gitContextWithPendingTurn(
  focus: ContextEngineMachineContext["focus"],
  routingStatus: "unbound" | "bound" | "clarifying",
): ContextEngineMachineContext {
  return {
    ...gitContext(focus),
    pendingTurn: {
      routingStatus,
      fromSeq: 1,
      toSeq: 1,
      text: "continue the website task",
      at: "2026-07-07T08:00:00.000Z",
    },
  };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    async execute() {
      return { ok: true, output: "" };
    },
  };
}

describe("runtime capability modes", () => {
  it("detects fresh-session routing and exposes compact prompt context", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
    });

    expect(mode.name).toBe("fresh_session_routing");
    expect(mode.allowToolLoading).toBe(false);
    expect(buildRuntimeCapabilityPromptContext(mode)).toMatchObject({
      name: "fresh_session_routing",
      why: "No active task exists.",
      allowed: [
        "direct_reply",
        "git_context_activate_task_for_turn",
        "git_context_create_task_for_turn",
      ],
      blocked: [
        "normal_work_tools",
        "decision_load_tools",
        "task_activation",
      ],
      rules: [
        "Create a task only when the current user request has a concrete deliverable and enough detail to begin work now.",
        "Do not create a task for early conversation, brainstorming, vague intent, preferences, or discovery. Reply directly with one short clarifying question.",
        "A concrete deliverable means the user has specified what to make, change, analyze, or produce, and the expected output is clear enough to start without another user answer.",
        "For clear durable work with no active task, call git_context_create_task_for_turn with title, objective, and createReason \"no_active_task\" before mutation. If existing task ownership is possible, use git_context_search_tasks and git_context_activate_task_for_turn instead.",
        "Never print task metadata JSON as the assistant response. Put task metadata in the native tool call arguments.",
      ],
      repairCode: "R_FRESH_SESSION_NEEDS_TASK",
    });
  });

  it("allows safe read and first-task routing tools in a fresh session", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
    });

    const allowed = filterToolsForRuntimeMode(mode, [
      tool("write_files"),
      tool("git_context_search_tasks"),
      tool("git_context_activate_task_for_turn"),
      tool("git_context_create_task_for_turn"),
    ]).map((entry) => entry.name);

    expect(allowed).toEqual([
      "git_context_search_tasks",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
    ]);
    expect(allowed).not.toContain("write_files");
  });

  it("allows taxonomy read-only tools during an active session run before task binding", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
      sessionRunHandle: { sessionId: "s1", runId: "R-session" },
    });

    expect(mode.name).toBe("fresh_session_routing");
    expect(mode.hasSessionRun).toBe(true);
    expect(mode.allowToolLoading).toBe(true);
    expect(buildRuntimeCapabilityPromptContext(mode)).toMatchObject({
      allowed: expect.arrayContaining(["decision_load_tools", "read_only_tools"]),
      blocked: expect.arrayContaining(["workspace_mutation_until_task_promotion"]),
    });
    expect(filterToolsForRuntimeMode(mode, [
      tool("read_file"),
      tool("document_query"),
      tool("write_files"),
      tool("git_context_activate_task_for_turn"),
      tool("git_context_create_task_for_turn"),
    ]).map((entry) => entry.name)).toEqual([
      "read_file",
      "document_query",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
    ]);
  });

  it("allows only direct replies or fresh-session routing decisions before the first task", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
    });
    const reply: AgentDecision = {
      kind: "reply",
      status: "completed",
      message: "What kind of file should I create?",
    };
    const route: AgentDecision = {
      kind: "act",
      action: {
        mode: "single",
        allowedTools: ["git_context_create_task_for_turn"],
        assertions: [],
        calls: [{
          id: "call_1",
          tool: "git_context_create_task_for_turn",
          input: {
            title: "Create text file",
            objective: "Create the requested text file.",
            reason: "The user requested durable file work.",
          },
          dependsOn: [],
        }],
      },
    };
    const loadTools: AgentDecision = {
      kind: "load_tools",
      request: {
        toolNames: ["write_files"],
        groups: [],
      },
    };

    expect(isDecisionAllowedInRuntimeMode(mode, reply)).toBe(true);
    expect(isDecisionAllowedInRuntimeMode(mode, route)).toBe(true);
    expect(isDecisionAllowedInRuntimeMode(mode, loadTools)).toBe(false);
  });

  it("allows read-only decisions during an active session run before first-task routing", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
      sessionRunHandle: { sessionId: "s1", runId: "R-session" },
    });
    const read: AgentDecision = {
      kind: "act",
      action: {
        mode: "single",
        allowedTools: ["read_file"],
        assertions: [],
        calls: [{
          id: "call_1",
          tool: "read_file",
          input: { path: "README.md" },
          dependsOn: [],
        }],
      },
    };
    const mutate: AgentDecision = {
      kind: "act",
      action: {
        mode: "single",
        allowedTools: ["write_files"],
        assertions: [],
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: { files: [] },
          dependsOn: [],
        }],
      },
    };

    expect(isDecisionAllowedInRuntimeMode(mode, read)).toBe(true);
    expect(isDecisionAllowedInRuntimeMode(mode, { kind: "load_tools", request: { toolNames: ["read_file"], groups: [] } })).toBe(true);
    expect(isDecisionAllowedInRuntimeMode(mode, mutate)).toBe(false);
  });

  it("allows read-only git-context actions in fresh-session read mode", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
    });
    const read: AgentDecision = {
      kind: "act",
      action: {
        mode: "single",
        allowedTools: ["git_context_list_tasks"],
        assertions: [],
        calls: [{
          id: "call_1",
          tool: "git_context_list_tasks",
          input: {},
          dependsOn: [],
        }],
      },
    };

    expect(isDecisionAllowedInRuntimeMode(mode, read)).toBe(true);
  });

  it("projects routing-window timing before a work run exists", () => {
    const firstStep = state(gitContextWithPendingTurn({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }, "unbound"));
    firstStep.iteration = 1;
    const secondStep = state(gitContextWithPendingTurn({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }, "unbound"));
    secondStep.iteration = 2;
    const expired = state(gitContextWithPendingTurn({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }, "unbound"));
    expired.iteration = 3;

    expect(buildRuntimeCapabilityPromptContext(detectRuntimeCapabilityMode({ state: firstStep })).routingWindow).toMatchObject({
      open: true,
      step: 1,
      maxSteps: 2,
      remaining: 1,
      expiresAfterThisDecision: false,
      readToolsAvailable: true,
      routingToolsAvailable: true,
      readToolsRemainAfterExpiry: true,
    });
    expect(buildRuntimeCapabilityPromptContext(detectRuntimeCapabilityMode({ state: secondStep })).routingWindow).toMatchObject({
      open: true,
      step: 2,
      remaining: 0,
      expiresAfterThisDecision: true,
      routingToolsAvailable: true,
    });
    expect(buildRuntimeCapabilityPromptContext(detectRuntimeCapabilityMode({ state: expired })).routingWindow).toMatchObject({
      open: false,
      expired: true,
      step: 3,
      remaining: 0,
      expiresAfterThisDecision: false,
      readToolsAvailable: true,
      routingToolsAvailable: false,
      readToolsRemainAfterExpiry: true,
    });
  });

  it("allows normal tools for active task continuation before the run is allocated", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({
        status: "active",
        ref: "refs/heads/task/T-1",
        workId: "T-1",
      })),
    });

    expect(mode.name).toBe("active_task_ready");
    expect(mode.allowToolLoading).toBe(true);
    expect(buildRuntimeCapabilityPromptContext(mode)).toMatchObject({
      name: "active_task_ready",
      allowed: expect.arrayContaining([
        "direct_reply",
        "decision_load_tools",
        "normal_work_tools",
        "git_context_activate_task_for_turn",
        "git_context_create_task_for_turn",
      ]),
      blocked: [],
    });
    expect(buildRuntimeCapabilityPromptContext(mode).routingWindow).toMatchObject({
      open: true,
      step: 1,
      routingToolsAvailable: true,
    });
    expect(filterToolsForRuntimeMode(mode, [
      tool("git_context_search_tasks"),
      tool("git_context_create_task_for_turn"),
      tool("git_context_activate_task_for_turn"),
      tool("write_files"),
    ]).map((entry) => entry.name)).toEqual([
      "git_context_search_tasks",
      "git_context_create_task_for_turn",
      "git_context_activate_task_for_turn",
      "write_files",
    ]);
  });

  it("expires active-task routing tools before run allocation while keeping normal tools", () => {
    const current = state(gitContext({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }));
    current.iteration = 3;
    const mode = detectRuntimeCapabilityMode({ state: current });

    expect(mode.name).toBe("active_task_ready");
    expect(buildRuntimeCapabilityPromptContext(mode).routingWindow).toMatchObject({
      open: false,
      expired: true,
      routingToolsAvailable: false,
    });
    expect(filterToolsForRuntimeMode(mode, [
      tool("git_context_create_task_for_turn"),
      tool("git_context_activate_task_for_turn"),
      tool("write_files"),
    ]).map((entry) => entry.name)).toEqual([
      "write_files",
    ]);
  });

  it("keeps active-task routing tools after a failed routing attempt", () => {
    const current = state(gitContext({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }));
    current.iteration = 2;
    current.completedSteps.push({
      step: 1,
      outcome: "failed",
      summary: "Task creation was rejected.",
      newFacts: [],
      artifacts: [],
      toolsUsed: ["git_context_create_task_for_turn"],
      toolSuccessCount: 0,
      toolFailureCount: 1,
    });
    const mode = detectRuntimeCapabilityMode({ state: current });

    expect(mode.name).toBe("active_task_ready");
    expect(buildRuntimeCapabilityPromptContext(mode).routingWindow).toMatchObject({
      open: true,
      step: 2,
      routingToolsAvailable: true,
      expiresAfterThisDecision: true,
    });
    expect(filterToolsForRuntimeMode(mode, [
      tool("git_context_create_task_for_turn"),
      tool("git_context_activate_task_for_turn"),
      tool("write_files"),
    ]).map((entry) => entry.name)).toEqual([
      "git_context_create_task_for_turn",
      "git_context_activate_task_for_turn",
      "write_files",
    ]);
  });

  it("omits routing-window timing once a work run exists", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({
        status: "active",
        ref: "refs/heads/task/T-1",
        workId: "T-1",
      }), "R-1"),
    });

    expect(buildRuntimeCapabilityPromptContext(mode).routingWindow).toBeUndefined();
  });

  it("hides task-routing mutation tools once a work run exists", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({
        status: "active",
        ref: "refs/heads/task/T-1",
        workId: "T-1",
      }), "R-1"),
    });

    expect(filterToolsForRuntimeMode(mode, [
      tool("git_context_search_tasks"),
      tool("git_context_create_task_for_turn"),
      tool("git_context_activate_task_for_turn"),
      tool("write_files"),
    ]).map((entry) => entry.name)).toEqual([
      "git_context_search_tasks",
      "write_files",
    ]);
  });
});
