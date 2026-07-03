import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";

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

  it("exposes git task-routing tools for the first two decision stages and then expires them", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task_for_turn"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_ask_clarification_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("hii");

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });
    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_active",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_read_task",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 2 });
    expect(manager.listActive({ runId: "r1" })).toContain("git_context_create_task_for_turn");

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 3 });
    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_active",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_read_task",
    ]);
  });

  it("preloads likely work tools with create and clarify routing tools when no active task exists", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_file"),
      ]),
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task_for_turn"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_ask_clarification_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("create a linux commands txt file");
    runState.runId = "";
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });

    expect(manager.listActive({ runId: "r1" })).toEqual([
      "write_file",
      "git_context_active",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_read_task",
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);
  });

  it("uses the full routing window when an active task exists", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task_for_turn"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_ask_clarification_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue the website");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({
        status: "active",
        ref: "refs/heads/task/T-20260702-001-website",
        workId: "T-20260702-001",
      }),
    });

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });

    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_active",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_read_task",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);
  });

  it("keeps routing tools after a safe read lookup within the routing window", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(state("find old upload task"), context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "git_context_search_tasks",
      input: {},
      output: "matched upload task",
    }], context);
    manager.cleanupAfterStep(context);

    expect(manager.listActive(context)).toEqual([
      "git_context_search_tasks",
      "git_context_create_task_for_turn",
    ]);
  });

  it("removes routing tools immediately after successful create or switch routing", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_activate_task_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(state("build a website"), context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "git_context_create_task_for_turn",
      input: {},
      output: "created task",
    }], context);

    expect(manager.listActive(context)).toEqual([]);
  });

  it("does not re-add routing tools after a routing tool already ran in the loop", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_activate_task_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue after task creation");
    runState.completedSteps = [{
      toolsUsed: ["git_context_create_task_for_turn"],
    } as LoopState["completedSteps"][number]];

    manager.prepareForDecision(runState, { clientId: "c1", runId: "real-run", sessionId: "s1", stepNumber: 2 });

    expect(manager.listActive({ runId: "real-run" })).toEqual([]);
  });
});

function contextEngineWithFocus(focus: ContextEngineMachineContext["focus"]): ContextEngineMachineContext {
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
