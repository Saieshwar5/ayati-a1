import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";

function tool(name: string, description = name): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true, output: `${name}-ok` };
    },
  };
}

function skill(id: string, tools: ToolDefinition[]): SkillDefinition {
  return {
    id,
    version: "1.0.0",
    description: `${id} skill`,
    promptBlock: "",
    tools,
  };
}

function state(userMessage: string): LoopState {
  return {
    runId: "r1",
    runClass: "task",
    userMessage,
    workState: {
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/r1",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(),
  };
}

describe("ToolWorkingSetManager", () => {
  it("preloads likely tools before the decision and enforces last-tool eviction", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("search_in_files", "Search in files"),
        tool("read_file", "Read file"),
        tool("edit_file", "Edit file"),
        tool("write_file", "Write file"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 3 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(state("find and edit the config file"), context);
    expect(manager.listActive(context)).toHaveLength(3);

    manager.load({ toolNames: ["write_file"], reason: "need write fallback" }, context);
    expect(manager.listActive(context)).toEqual(["find_files", "search_in_files", "write_file"]);
    expect(executor.list(context)).toEqual(["find_files", "search_in_files", "write_file"]);
  });

  it("loads deterministic follow-up tools after execution and deactivates success-scoped tools", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("read_file", "Read file"),
        tool("edit_file", "Edit file"),
        tool("write_file", "Write file"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 4 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.load({ toolNames: ["find_files"], reason: "start search" }, context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "find_files",
      input: {},
      output: "src/index.ts",
    }], context);

    expect(manager.listActive(context)).toEqual(["read_file", "edit_file", "write_file"]);
  });
});
