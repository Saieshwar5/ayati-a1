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
        "git_context_list_sessions",
        "git_context_active",
        "git_context_list_tasks",
        "git_context_search_tasks",
        "git_context_read_task",
        "git_context_read_evidence",
        "git_context_search_evidence",
        "git_context_log",
        "git_context_create_task_for_turn",
        "git_context_ask_clarification_for_turn",
      ],
      blocked: [
        "normal_work_tools",
        "decision_load_tools",
        "task_activation",
      ],
      rules: [
        "Reply directly only for casual chat, explanation-only questions, thanks, or planning discussion.",
        "If the current user asks to create, write, edit, build, run, test, fix, save, or change an artifact, file, code, doc, site, or app, do not reply directly.",
        "For durable work, call git_context_create_task_for_turn with title, objective, and reason.",
        "Never print task metadata JSON as the assistant response. Put task metadata in the native tool call arguments.",
        "If unsure whether the request is durable work, ask a short clarification.",
      ],
      repairCode: "R_FRESH_SESSION_NEEDS_TASK",
    });
  });

  it("keeps tools visible in fresh session so the runner can repair normal work attempts", () => {
    const mode = detectRuntimeCapabilityMode({
      state: state(gitContext({ status: "none" })),
    });

    expect(filterToolsForRuntimeMode(mode, [
      tool("write_files"),
      tool("git_context_search_tasks"),
      tool("git_context_create_task_for_turn"),
      tool("git_context_ask_clarification_for_turn"),
    ]).map((entry) => entry.name)).toEqual([
      "write_files",
      "git_context_search_tasks",
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
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
    const firstStep = state(gitContext({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }));
    firstStep.iteration = 1;
    const secondStep = state(gitContext({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }));
    secondStep.iteration = 2;
    const expired = state(gitContext({
      status: "active",
      ref: "refs/heads/task/T-1",
      workId: "T-1",
    }));
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
});
