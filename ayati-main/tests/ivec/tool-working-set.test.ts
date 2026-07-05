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
    runId: "",
    runClass: "interaction",
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
    runPath: "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext(),
  };
}

describe("ToolWorkingSetManager", () => {
  it("preloads likely tools before the decision and enforces lifecycle-priority eviction", () => {
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
    expect(manager.listActive(context)).toEqual(["search_in_files", "read_file", "write_file"]);
    expect(executor.list(context)).toEqual(["search_in_files", "read_file", "write_file"]);
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

  it("keeps read and write file tools active across task-run steps", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("read_file", "Read file"),
        tool("read_files", "Read files"),
        tool("search_in_files", "Search in files"),
        tool("write_file", "Write file"),
        tool("write_files", "Write files"),
        tool("edit_file", "Edit file"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 15 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.load({ groups: ["file:read", "file:write"] }, context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "write_files",
      input: {},
      output: "written",
    }], context);
    manager.cleanupAfterStep(context);

    const nextContext = { ...context, stepNumber: 2 };
    manager.prepareForDecision({ ...state("continue writing files"), runId: "r1" }, nextContext);

    expect(manager.listActive(nextContext)).toEqual(expect.arrayContaining([
      "read_file",
      "read_files",
      "search_in_files",
      "write_file",
      "write_files",
      "edit_file",
    ]));
  });

  it("preloads file tools instead of shell or UI tools for project creation", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("search_in_files", "Search in files"),
        tool("list_directory", "List directory"),
        tool("read_file", "Read file"),
        tool("read_files", "Read files"),
        tool("write_file", "Write file"),
        tool("write_files", "Write files"),
        tool("edit_file", "Edit file"),
        tool("create_directory", "Create directory"),
      ]),
      skill("shell", [
        tool("shell", "Run shell command"),
        tool("shell_run_script", "Run shell script"),
      ]),
      skill("ui", [
        tool("workspace_get_state", "Get workspace state"),
        tool("workspace_set_layout", "Set workspace layout"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 15 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };
    const runState = state("Build a small vanilla HTML/CSS/JS project that is usable in the browser");
    runState.runId = "r1";

    manager.prepareForDecision(runState, context);

    const active = manager.listActive(context);
    expect(active).toEqual(expect.arrayContaining([
      "list_directory",
      "read_file",
      "read_files",
      "write_file",
      "write_files",
      "create_directory",
    ]));
    expect(active).not.toContain("shell");
    expect(active).not.toContain("shell_run_script");
    expect(active).not.toContain("workspace_get_state");
    expect(active).not.toContain("workspace_set_layout");
  });

  it("preloads shell tools for explicit command execution", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("search_in_files", "Search in files"),
        tool("read_file", "Read file"),
      ]),
      skill("shell", [
        tool("shell", "Run shell command"),
        tool("shell_run_script", "Run shell script"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 15 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };
    const runState = state("Run pnpm build and fix any compile errors");
    runState.runId = "r1";

    manager.prepareForDecision(runState, context);

    expect(manager.listActive(context)).toEqual(expect.arrayContaining([
      "shell",
      "shell_run_script",
      "search_in_files",
      "read_file",
    ]));
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

  it("preloads only create and clarify routing tools when no active task exists", () => {
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
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);
  });

  it("keeps fresh-session routing mutation tools visible under the tool cap", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_file"),
        tool("write_files"),
        tool("create_directory"),
        tool("shell_run_script"),
        tool("shell"),
        tool("search_in_files"),
        tool("find_files"),
        tool("read_file"),
        tool("edit_file"),
      ]),
      skill("git-context", [
        tool("git_context_list_sessions"),
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_read_evidence"),
        tool("git_context_search_evidence"),
        tool("git_context_log"),
        tool("git_context_activate_task_for_turn"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_ask_clarification_for_turn"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("create a website, write files, run tests, and search the project");
    runState.runId = "";
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(runState, context);

    expect(manager.listActive(context)).toEqual([
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);
    expect(manager.listActive(context)).toContain("git_context_create_task_for_turn");
    expect(manager.listActive(context)).toContain("git_context_ask_clarification_for_turn");
    expect(executor.list(context)).toContain("git_context_create_task_for_turn");
    expect(executor.list(context)).toContain("git_context_ask_clarification_for_turn");
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

  it("removes write and shell tools before an active task turn is bound to a work run", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files"),
        tool("search_in_files"),
        tool("read_file"),
        tool("write_file"),
        tool("write_files"),
        tool("create_directory"),
      ]),
      skill("shell", [
        tool("shell"),
        tool("shell_run_script"),
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
    const runState = state("write files, create a folder, run a command, and show where it is");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({
        status: "active",
        ref: "refs/heads/task/T-20260702-001-website",
        workId: "T-20260702-001",
      }),
    });
    const context = { clientId: "c1", runId: "decision:s1:1", sessionId: "s1", stepNumber: 1 };

    const result = manager.prepareForDecision(runState, context);
    const active = manager.listActive(context);

    expect(active).toEqual([
      "find_files",
      "search_in_files",
      "read_file",
      "git_context_active",
      "git_context_list_tasks",
      "git_context_search_tasks",
      "git_context_read_task",
      "git_context_activate_task_for_turn",
      "git_context_create_task_for_turn",
      "git_context_ask_clarification_for_turn",
    ]);
    expect(active).not.toContain("write_file");
    expect(active).not.toContain("write_files");
    expect(active).not.toContain("create_directory");
    expect(active).not.toContain("shell");
    expect(active).not.toContain("shell_run_script");
    expect(result.evicted).toEqual(expect.arrayContaining([
      "write_file",
      "write_files",
    ]));
    expect(executor.list(context)).toEqual(active);
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

  it("removes task-routing mutation tools when a work run is active", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task_for_turn"),
        tool("git_context_activate_task_for_turn"),
        tool("git_context_ask_clarification_for_turn"),
      ]),
      skill("filesystem", [
        tool("write_files"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const context = { clientId: "c1", runId: "real-run", sessionId: "s1", stepNumber: 2 };
    const runState = state("write the file");
    runState.runId = "real-run";

    manager.load({
      toolNames: [
        "git_context_search_tasks",
        "git_context_create_task_for_turn",
        "git_context_activate_task_for_turn",
        "git_context_ask_clarification_for_turn",
        "write_files",
      ],
    }, context);
    manager.prepareForDecision(runState, context);

    expect(manager.listActive(context)).toEqual([
      "git_context_search_tasks",
      "write_files",
    ]);
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
