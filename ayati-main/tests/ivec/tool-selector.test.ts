import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import {
  selectToolsForDecision,
} from "../../src/ivec/agent-runner/tool-selector.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";

function tool(name: string, priority = 0): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    selectionHints: {
      tags: [name, "create", "file", "website"],
      priority,
    },
    async execute() {
      return { ok: true, output: "" };
    },
  };
}

function state(userMessage: string): LoopState {
  return {
    runId: "run-1",
    runClass: "task",
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
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/run-1",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(),
  };
}

function pendingGitContext(
  routingStatus: "unbound" | "clarifying",
): ContextEngineMachineContext {
  return {
    session: {
      sessionId: "S-20260630-local",
      conversationTail: [],
      activityTail: [],
      assetCount: 0,
    },
    pendingTurn: {
      fromSeq: 1,
      toSeq: 1,
      text: "build a website",
      at: "2026-06-30T10:00:00.000Z",
      routingStatus,
    },
    focus: {
      status: "none",
    },
  };
}

describe("selectToolsForDecision", () => {
  it("selects only relevant visible tools within the configured cap", () => {
    const tools = [
      tool("read_file", 10),
      tool("edit_file", 10),
      tool("write_files", 10),
      tool("pulse", 1),
      tool("calculator", 1),
    ];

    const selected = selectToolsForDecision(
      state("create a small website demo for organic vegetables"),
      tools,
      3,
    );
    const selectedNames = selected.map((entry) => entry.name);

    expect(selectedNames).toContain("write_files");
    expect(selectedNames).toHaveLength(3);
    expect(selectedNames).not.toContain("pulse");
  });

  it("limits selected tools to git-context routing tools for unbound pending turns", () => {
    const current = state("build a website and run it");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };
    const selected = selectToolsForDecision(current, [
      tool("shell", 100),
      tool("write_files", 100),
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_create_task_for_turn", 1),
    ], 12);

    expect(selected.map((entry) => entry.name)).toEqual([
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_create_task_for_turn",
    ]);
  });

  it("selects no executable tools while a pending turn is clarifying", () => {
    const current = state("build a website");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("clarifying"),
    };

    expect(selectToolsForDecision(current, [
      tool("git_context_list_tasks", 1),
      tool("git_context_create_task_for_turn", 1),
      tool("shell", 100),
    ], 12)).toEqual([]);
  });
});
