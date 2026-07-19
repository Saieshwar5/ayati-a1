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
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    routingAttempts: {
      successCount: 0,
      failureCount: 0,
      maxFailures: 2,
      resolved: false,
    },
    runPath: "/tmp/run-1",
    failureHistory: [],
    harnessContext: createInitialHarnessContext({
      contextEngine: {
        session: {
          meta: { sessionId: "S-1", assetCount: 0 },
          conversationTail: [],
          activityTail: [],
        },
        pendingTurn: {
          fromSeq: 1,
          toSeq: 1,
          text: userMessage,
          at: "2026-07-19T10:00:00.000Z",
          routingStatus: "bound",
          workId: "T-1",
          branch: "task/T-1",
          runId: "run-1",
        },
        focus: {
          status: "active",
          ref: "refs/heads/task/T-1",
          workId: "T-1",
        },
      },
    }),
  };
}

function pendingGitContext(
  routingStatus: "unbound" | "clarifying",
  focus: ContextEngineMachineContext["focus"] = {
    status: "active",
    ref: "refs/heads/task/T-20260630-0001-website",
    workId: "T-20260630-0001",
  },
): ContextEngineMachineContext {
  return {
    session: {
      meta: { sessionId: "S-20260630-local", assetCount: 0 },
      conversationTail: [],
      activityTail: [],
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
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };
    const selected = selectToolsForDecision(current, [
      tool("process_run", 100),
      tool("write_files", 100),
      tool("git_context_activate_workstream", 1),
      tool("git_context_create_workstream", 1),
    ], 12);

    expect(selected.map((entry) => entry.name)).toEqual([
      "git_context_activate_workstream",
      "git_context_create_workstream",
    ]);
  });

  it("selects safe read and first-task routing tools when a fresh session has no active task", () => {
    const current = state("build a website and run it");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };
    const selected = selectToolsForDecision(current, [
      tool("process_run", 100),
      tool("write_files", 100),
      tool("git_context_activate_workstream", 1),
      tool("git_context_create_workstream", 1),
    ], 12);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "git_context_activate_workstream",
      "git_context_create_workstream",
    ]);
    expect(selectedNames).not.toContain("process_run");
    expect(selectedNames).not.toContain("write_files");
  });

  it("selects observational tools on an unbound run", () => {
    const current = state("where is upload handling implemented?");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("read_files", 90),
      tool("search_in_files", 80),
      tool("document_query", 70),
      tool("git_context_create_workstream", 1),
    ], 3);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "read_files",
      "search_in_files",
      "document_query",
    ]);
  });

  it("counts required first-task routing tools inside the selected tool cap", () => {
    const current = state("create a small website and run it");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound", { status: "none" }),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("create_directory", 80),
      tool("process_run", 70),
      tool("search_in_files", 60),
      tool("git_context_list_tasks", 1),
      tool("git_context_find_workstreams", 1),
      tool("git_context_activate_workstream", 1),
      tool("git_context_create_workstream", 1),
    ], 3);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "search_in_files",
      "git_context_activate_workstream",
      "git_context_create_workstream",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("create_directory");
    expect(selectedNames).not.toContain("process_run");
  });

  it("reserves the selected tool cap for required active-task routing tools", () => {
    const current = state("continue the website and add dark mode");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("unbound"),
    };

    const selected = selectToolsForDecision(current, [
      tool("write_files", 100),
      tool("patch_files", 90),
      tool("read_files", 80),
      tool("git_context_list_tasks", 1),
      tool("git_context_find_workstreams", 1),
      tool("git_context_activate_workstream", 1),
      tool("git_context_create_workstream", 1),
    ], 2);

    const selectedNames = selected.map((entry) => entry.name);
    expect(selectedNames).toEqual([
      "git_context_activate_workstream",
      "git_context_create_workstream",
    ]);
    expect(selectedNames).not.toContain("write_files");
    expect(selectedNames).not.toContain("patch_files");
  });

  it("selects no executable tools while a pending turn is clarifying", () => {
    const current = state("build a website");
    current.harnessContext = {
      ...current.harnessContext,
      contextEngine: pendingGitContext("clarifying"),
    };

    expect(selectToolsForDecision(current, [
      tool("git_context_list_tasks", 1),
      tool("git_context_create_workstream", 1),
      tool("process_run", 100),
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
    const tools = [
      "read_files",
      "search_in_files",
      "find_files",
      "inspect_paths",
      "list_directory",
      "write_files",
      "patch_files",
      "create_directory",
      "move",
      "delete",
      "process_run",
      "process_start",
      "process_poll",
      "process_send_input",
      "process_stop",
    ].map((name, index) => tool(name, 15 - index));

    expect(selectToolsForDecision(current, tools, 15)).toHaveLength(15);

    current.contextPressure = {
      ...createInitialContextPressureState(),
      mode: "tool_compact",
    };
    expect(selectToolsForDecision(current, tools, 15)).toHaveLength(10);
  });
});
