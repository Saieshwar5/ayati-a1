import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import { createInitialContextPressureState } from "../../src/ivec/context-pressure-state.js";
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
  it("uses a compact hidden-tool loading map after context pressure", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [tool("read_files", "Read files")]),
      skill("process", [tool("process_run", "Run one project executable")]),
    ]);
    const manager = new ToolWorkingSetManager({
      catalog,
      toolExecutor: createToolExecutor([]),
    });

    const full = manager.getPromptSummary();
    const compact = manager.getPromptSummary({ compact: true });

    expect(full).toContain("Loadable groups:");
    expect(full).toContain("Loadable skills:");
    expect(full).not.toContain("returning load_tools");
    expect(compact).toContain("Loadable tools are indexed by exact name, focused group, or query.");
    expect(compact).not.toContain("Loadable groups:");
    expect(compact).not.toContain("Loadable skills:");
    expect(compact.length).toBeLessThan(full.length);
  });

  it("preloads likely tools before the decision and enforces lifecycle-priority eviction", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("search_in_files", "Search in files"),
        tool("read_files", "Read file"),
        tool("patch_files", "Patch files"),
        tool("write_files", "Write files"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 3 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(state("find and edit the config file"), context);
    expect(manager.listActive(context)).toHaveLength(3);

    manager.load({ toolNames: ["write_files"], reason: "need write fallback" }, context);
    expect(manager.listActive(context)).toEqual(["search_in_files", "read_files", "write_files"]);
    expect(executor.list(context)).toEqual(["search_in_files", "read_files", "write_files"]);
  });

  it("loads deterministic follow-up tools after execution and deactivates success-scoped tools", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("read_files", "Read file"),
        tool("patch_files", "Patch files"),
        tool("write_files", "Write files"),
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

    expect(manager.listActive(context)).toEqual(["read_files", "patch_files", "write_files"]);
  });

  it("keeps read and write file tools active across task-run steps", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("read_files", "Read file"),
        tool("read_files", "Read files"),
        tool("search_in_files", "Search in files"),
        tool("write_files", "Write files"),
        tool("patch_files", "Patch files"),
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
      "read_files",
      "read_files",
      "search_in_files",
      "write_files",
      "patch_files",
    ]));
  });

  it("preloads file tools instead of process or UI tools for project creation", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files", "Find files"),
        tool("search_in_files", "Search in files"),
        tool("list_directory", "List directory"),
        tool("read_files", "Read file"),
        tool("read_files", "Read files"),
        tool("write_files", "Write files"),
        tool("patch_files", "Patch files"),
        tool("create_directory", "Create directory"),
      ]),
      skill("process", [
        tool("process_run", "Run one project executable"),
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
      "read_files",
      "read_files",
      "write_files",
      "create_directory",
    ]));
    expect(active).not.toContain("process_run");
    expect(active).not.toContain("workspace_get_state");
    expect(active).not.toContain("workspace_set_layout");
  });

  it("preloads process tools for explicit command execution", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("search_in_files", "Search in files"),
        tool("read_files", "Read file"),
      ]),
      skill("process", [
        tool("process_run", "Run one project executable"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 15 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };
    const runState = state("Run pnpm build and fix any compile errors");
    runState.runId = "r1";

    manager.prepareForDecision(runState, context);

    expect(manager.listActive(context)).toEqual(expect.arrayContaining([
      "process_run",
      "search_in_files",
      "read_files",
    ]));
  });

  it("keeps git task-routing tools visible until routing resolves", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_activate_task"),
        tool("git_context_create_task"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("hii");

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });
    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 2 });
    expect(manager.listActive({ runId: "r1" })).toContain("git_context_create_task");

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 3 });
    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);

    runState.completedSteps.push({
      step: 3,
      outcome: "completed",
      summary: "Task activated.",
      newFacts: [],
      artifacts: [],
      toolsUsed: ["git_context_activate_task"],
      toolSuccessCount: 1,
      toolFailureCount: 0,
    });
    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 4 });
    expect(manager.listActive({ runId: "r1" })).toEqual([]);
  });

  it("preloads only activate and create routing tools when no active task exists", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_files"),
      ]),
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task"),
        tool("git_context_create_task"),
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
      "git_context_activate_task",
      "git_context_create_task",
    ]);
  });

  it("keeps fresh-session routing controls visible under the tool cap", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_files"),
        tool("create_directory"),
        tool("process_run"),
        tool("process_run"),
        tool("search_in_files"),
        tool("find_files"),
        tool("read_files"),
        tool("patch_files"),
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
        tool("git_context_activate_task"),
        tool("git_context_create_task"),
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

    expect(manager.listActive(context)).toEqual(expect.arrayContaining([
      "find_files",
      "search_in_files",
      "read_files",
      "git_context_activate_task",
      "git_context_create_task",
    ]));
    expect(manager.listActive(context)).toContain("git_context_activate_task");
    expect(manager.listActive(context)).toContain("git_context_create_task");
    expect(executor.list(context)).toContain("git_context_activate_task");
    expect(executor.list(context)).toContain("git_context_create_task");
  });

  it("uses the full routing window when an active task has an unbound pending turn", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task"),
        tool("git_context_create_task"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue the website");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithPendingTurn({
        status: "active",
        ref: "refs/heads/task/T-20260702-001-website",
        workId: "T-20260702-001",
      }, "unbound"),
    });

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });

    expect(manager.listActive({ runId: "r1" })).toEqual([
      "git_context_activate_task",
      "git_context_create_task",
    ]);
  });

  it("keeps mutation tools and routing-window tools available for active task continuation before run allocation", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("find_files"),
        tool("search_in_files"),
        tool("read_files"),
        tool("write_files"),
        tool("create_directory"),
      ]),
      skill("process", [
        tool("process_run"),
        tool("process_run"),
      ]),
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_search_tasks"),
        tool("git_context_read_task"),
        tool("git_context_activate_task"),
        tool("git_context_create_task"),
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

    expect(active).toEqual(expect.arrayContaining([
      "find_files",
      "search_in_files",
      "read_files",
      "write_files",
      "git_context_activate_task",
      "git_context_create_task",
    ]));
    expect(result.evicted).not.toEqual(expect.arrayContaining([
      "write_files",
    ]));
    expect(executor.list(context)).toEqual(active);
  });

  it("removes routing controls immediately after successful create or switch routing", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task"),
        tool("git_context_activate_task"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(state("build a website"), context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "git_context_create_task",
      input: {},
      output: "created task",
    }], context);

    expect(manager.listActive(context)).toEqual([]);
  });

  it("does not re-add routing tools after a routing tool already ran in the loop", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task"),
        tool("git_context_activate_task"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue after task creation");
    runState.completedSteps = [{
      toolsUsed: ["git_context_create_task"],
    } as LoopState["completedSteps"][number]];

    manager.prepareForDecision(runState, { clientId: "c1", runId: "real-run", sessionId: "s1", stepNumber: 2 });

    expect(manager.listActive({ runId: "real-run" })).toEqual([
      "git_context_search_tasks",
    ]);
  });

  it("removes task-routing controls when a work run is active", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_search_tasks"),
        tool("git_context_create_task"),
        tool("git_context_activate_task"),
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
        "git_context_create_task",
        "git_context_activate_task",
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

function contextEngineWithPendingTurn(
  focus: ContextEngineMachineContext["focus"],
  routingStatus: "unbound" | "bound" | "clarifying",
): ContextEngineMachineContext {
  return {
    ...contextEngineWithFocus(focus),
    pendingTurn: {
      routingStatus,
      fromSeq: 1,
      toSeq: 1,
      text: "continue the website",
      at: "2026-07-07T08:00:00.000Z",
    },
  };
}

function recoverableToolCalls(): NonNullable<LoopState["toolContext"]>["toolCalls"] {
  return [
    {
      step: 1,
      callId: "call-old",
      tool: "read_files",
      input: { path: "src/old.ts" },
      status: "success",
      output: `old output ${"x".repeat(16_000)}`,
      outputTruncated: true,
      stepRef: { runId: "r1", step: 1, callId: "call-old" },
    },
    {
      step: 2,
      callId: "call-2",
      tool: "read_files",
      input: { path: "src/2.ts" },
      status: "success",
      output: `output 2 ${"x".repeat(16_000)}`,
      stepRef: { runId: "r1", step: 2, callId: "call-2" },
    },
    {
      step: 3,
      callId: "call-3",
      tool: "read_files",
      input: { path: "src/3.ts" },
      status: "success",
      output: `output 3 ${"x".repeat(16_000)}`,
      stepRef: { runId: "r1", step: 3, callId: "call-3" },
    },
    {
      step: 4,
      callId: "call-4",
      tool: "read_files",
      input: { path: "src/4.ts" },
      status: "success",
      output: "output 4",
      stepRef: { runId: "r1", step: 4, callId: "call-4" },
    },
    {
      step: 5,
      callId: "call-5",
      tool: "read_files",
      input: { path: "src/5.ts" },
      status: "success",
      output: "output 5",
      stepRef: { runId: "r1", step: 5, callId: "call-5" },
    },
  ];
}
