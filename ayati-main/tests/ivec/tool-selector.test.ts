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
    current.runId = "";
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
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_activate_task_for_turn", 1),
      tool("git_context_create_task_for_turn", 1),
    ], 12);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
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
      tool("read_file", 90),
      tool("search_in_files", 80),
      tool("document_query", 70),
      tool("git_context_create_task_for_turn", 1),
    ], 3, {
      sessionRunHandle: { sessionId: "S-20260630-local", runId: "R-20260630-0001" },
    });

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "read_file",
      "search_in_files",
      "document_query",
      "git_context_create_task_for_turn",
    ]);
    expect(selectedNames).not.toContain("write_files");
  });

  it("keeps first-task routing tools available regardless of selected tool cap", () => {
    const current = state("create a small website and run it");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("write_file", 90),
      tool("create_directory", 80),
      tool("shell", 70),
      tool("search_in_files", 60),
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_activate_task_for_turn", 1),
      tool("git_context_create_task_for_turn", 1),
    ], 3);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "search_in_files",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("write_file");
    expect(selectedNames).not.toContain("create_directory");
    expect(selectedNames).not.toContain("shell");
  });

  it("does not count active-task routing mutation tools against the selected tool cap", () => {
    const current = state("continue the website and add dark mode");
    current.runId = "";
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("edit_file", 90),
      tool("read_file", 80),
      tool("git_context_list_tasks", 1),
      tool("git_context_search_tasks", 1),
      tool("git_context_activate_task_for_turn", 1),
      tool("git_context_create_task_for_turn", 1),
    ], 2);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "read_file",
      "git_context_list_tasks",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("edit_file");
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
      tool("git_context_create_task_for_turn", 1),
      tool("shell", 100),
    ], 12)).toEqual([]);
  });

  it("selects run-step recovery outside the cap when compacted stepRef tool-call context exists", () => {
    const current = state("continue implementation");
    current.toolContext = {
      recent: [],
      toolCalls: recoverableToolCalls(),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("read_file", 90),
      tool("git_context_read_run_step", 0),
    ], 1);

    expect(selected.map((entry) => entry.name)).toEqual([
      "write_files",
      "git_context_read_run_step",
    ]);
  });

  it("does not select run-step recovery when no compacted stepRef tool-call context exists", () => {
    const current = state("continue implementation");

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("read_file", 90),
      tool("git_context_read_run_step", 0),
    ], 1);

    expect(selected.map((entry) => entry.name)).toEqual(["write_files"]);
  });
});

function recoverableToolCalls(): NonNullable<LoopState["toolContext"]>["toolCalls"] {
  return [
    {
      step: 1,
      callId: "call-old",
      tool: "read_file",
      input: { path: "src/old.ts" },
      status: "success",
      output: `old output ${"x".repeat(16_000)}`,
      stepRef: { runId: "run-1", step: 1, callId: "call-old" },
    },
    {
      step: 2,
      callId: "call-2",
      tool: "read_file",
      input: { path: "src/2.ts" },
      status: "success",
      output: `output 2 ${"x".repeat(16_000)}`,
      stepRef: { runId: "run-1", step: 2, callId: "call-2" },
    },
    {
      step: 3,
      callId: "call-3",
      tool: "read_file",
      input: { path: "src/3.ts" },
      status: "success",
      output: `output 3 ${"x".repeat(16_000)}`,
      stepRef: { runId: "run-1", step: 3, callId: "call-3" },
    },
    {
      step: 4,
      callId: "call-4",
      tool: "read_file",
      input: { path: "src/4.ts" },
      status: "success",
      output: "output 4",
      stepRef: { runId: "run-1", step: 4, callId: "call-4" },
    },
    {
      step: 5,
      callId: "call-5",
      tool: "read_file",
      input: { path: "src/5.ts" },
      status: "success",
      output: "output 5",
      stepRef: { runId: "run-1", step: 5, callId: "call-5" },
    },
  ];
}
