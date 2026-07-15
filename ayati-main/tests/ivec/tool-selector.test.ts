import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import {
  selectToolsForDecision,
} from "../../src/ivec/agent-runner/tool-selector.js";
import { createInitialContextPressureState } from "../../src/ivec/context-pressure-state.js";
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
  focus: ContextEngineMachineContext["focus"] = {
    status: "active",
    ref: "refs/heads/work/W-20260630-0001-website",
    workId: "W-20260630-0001",
  },
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
    focus,
  };
}

describe("selectToolsForDecision", () => {
  it("selects only relevant visible tools within the configured cap", () => {
    const tools = [
      tool("read_files", 10),
      tool("patch_files", 10),
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
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };
    const selected = selectToolsForDecision(current, [
      tool("shell", 100),
      tool("write_files", 100),
      tool("git_context_activate_task", 1),
      tool("git_context_create_task", 1),
    ], 12);

    expect(selected.map((entry) => entry.name)).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);
  });

  it("selects safe read and first-task routing tools when a fresh session has no active task", () => {
    const current = state("build a website and run it");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };
    const selected = selectToolsForDecision(current, [
      tool("shell", 100),
      tool("write_files", 100),
      tool("git_context_activate_task", 1),
      tool("git_context_create_task", 1),
    ], 12);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);
    expect(selectedNames).not.toContain("shell");
    expect(selectedNames).not.toContain("write_files");
  });

  it("selects read-only tools during a session run before task binding", () => {
    const current = state("where is upload handling implemented?");
    current.runId = "";
    current.runClass = "interaction";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("read_files", 90),
      tool("search_in_files", 80),
      tool("document_query", 70),
      tool("git_context_create_task", 1),
    ], 3, {
      sessionRunHandle: { sessionId: "S-20260630-local", runId: "R-20260630-0001" },
    });

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "write_files",
      "read_files",
      "git_context_create_task",
    ]);
  });

  it("counts required first-task routing tools inside the selected tool cap", () => {
    const current = state("create a small website and run it");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("create_directory", 80),
      tool("shell", 70),
      tool("search_in_files", 60),
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_activate_task", 1),
      tool("git_context_create_task", 1),
    ], 3);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "search_in_files",
      "git_context_activate_task",
      "git_context_create_task",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("create_directory");
    expect(selectedNames).not.toContain("shell");
  });

  it("reserves the selected tool cap for required active-task routing tools", () => {
    const current = state("continue the website and add dark mode");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("patch_files", 90),
      tool("read_files", 80),
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_activate_task", 1),
      tool("git_context_create_task", 1),
    ], 2);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("patch_files");
  });

  it("selects no executable tools while a pending turn is clarifying", () => {
    const current = state("build a website");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("clarifying"),
    };

    expect(selectToolsForDecision(current, [
      tool("git_context_list_tasks", 1),
      tool("git_context_create_task", 1),
      tool("shell", 100),
    ], 12)).toEqual([]);
  });

  it("does not select run-step recovery when no compacted stepRef tool-call context exists", () => {
    const current = state("continue implementation");

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("read_files", 90),
      tool("git_context_read_run_step", 0),
    ], 1);

    expect(selected.map((entry) => entry.name)).toEqual(["write_files"]);
  });

  it("reduces the executable tool surface from fifteen to ten after pressure", () => {
    const current = state("continue implementation");
    const tools = Array.from({ length: 15 }, (_, index) => tool(`tool_${index + 1}`, 15 - index));

    expect(selectToolsForDecision(current, tools, 15)).toHaveLength(15);

    current.contextPressure = {
      ...createInitialContextPressureState(),
      mode: "tool_compact",
    };
    expect(selectToolsForDecision(current, tools, 15)).toHaveLength(10);
  });
});
