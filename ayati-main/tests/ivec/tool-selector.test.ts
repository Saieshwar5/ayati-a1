import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
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
});
