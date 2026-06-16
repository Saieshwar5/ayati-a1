import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import {
  ALWAYS_SELECTED_KERNEL_TOOL_NAMES,
  selectToolsForDecision,
} from "../../src/ivec/agent-runner/tool-selector.js";

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
    recentExchanges: [],
    activeFocus: [],
    sessionFocusCards: [],
    attentionShelf: [],
  };
}

describe("selectToolsForDecision", () => {
  it("always keeps shell and filesystem kernel tools visible outside the optional cap", () => {
    const optionalTools = [
      tool("skill_activate", 40),
      tool("skill_search", 35),
      tool("skill_describe", 30),
      tool("calculator", 25),
      tool("pulse", 20),
    ];
    const tools = [
      ...Array.from(ALWAYS_SELECTED_KERNEL_TOOL_NAMES).map((name) => tool(name, 1)),
      ...optionalTools,
    ];

    const selected = selectToolsForDecision(
      state("create a small website demo for organic vegetables"),
      tools,
      3,
    );
    const selectedNames = selected.map((entry) => entry.name);

    for (const name of ALWAYS_SELECTED_KERNEL_TOOL_NAMES) {
      expect(selectedNames).toContain(name);
    }
    expect(selectedNames).toContain("write_files");
    expect(selectedNames).toContain("write_file");
    expect(selectedNames).toContain("create_directory");
    expect(selectedNames).toContain("shell");
    expect(selectedNames.filter((name) => !ALWAYS_SELECTED_KERNEL_TOOL_NAMES.has(name))).toHaveLength(3);
  });
});
