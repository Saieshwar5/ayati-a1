import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import { createInitialContextPressureState } from "../../src/ivec/context-pressure-state.js";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import { deriveWorkstreamBindingCapabilityPolicy } from "../../src/ivec/agent-runner/workstream-binding-capability-policy.js";
import { createEntryVirtualModeState } from "../../src/ivec/agent-runner/virtual-mode.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

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
    currentSeq: 1,
    inputKind: "user_message",
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
    virtualMode: createEntryVirtualModeState(),
    harnessContext: createInitialHarnessContext({
      contextEngine: contextEngineWithPendingTurn({
        status: "active",
        ref: "refs/heads/main",
        workstreamId: "W-1",
      }, "bound"),
    }),
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

  it("keeps ENTRY empty and replaces the complete capability surface between modes", () => {
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

    const runState = state("find and edit the config file");
    const policy = deriveWorkstreamBindingCapabilityPolicy(runState);
    manager.prepareForDecision(runState, context);
    expect(manager.listActive(context)).toEqual([]);

    const locate = manager.replaceWithTools(["find_files", "search_in_files"], context, policy);
    expect(locate.loaded).toEqual(["find_files", "search_in_files"]);
    expect(manager.listActive(context)).toEqual(["find_files", "search_in_files"]);

    const investigate = manager.replaceWithTools(["read_files"], context, policy);
    expect(investigate.evicted).toEqual(["find_files", "search_in_files"]);
    expect(manager.listActive(context)).toEqual(["read_files"]);
    expect(executor.list(context)).toEqual(["read_files"]);
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

    const runState = state("find the source file");
    const policy = deriveWorkstreamBindingCapabilityPolicy(runState);
    manager.load({ toolNames: ["find_files"], reason: "start search" }, context, policy);
    manager.afterExecution([{
      callId: "call_1",
      tool: "find_files",
      input: {},
      output: "src/index.ts",
    }], context, policy);

    expect(manager.listActive(context)).toEqual(["read_files", "patch_files", "write_files"]);
  });

  it("keeps read and write file tools active across workstream-bound steps", () => {
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

    const runState = state("continue writing files");
    const policy = deriveWorkstreamBindingCapabilityPolicy(runState);
    manager.load({ groups: ["file:read", "file:write"] }, context, policy);
    manager.afterExecution([{
      callId: "call_1",
      tool: "write_files",
      input: {},
      output: "written",
    }], context, policy);
    manager.cleanupAfterStep(context);

    const nextContext = { ...context, stepNumber: 2 };
    manager.prepareForDecision({ ...runState, runId: "r1" }, nextContext);

    expect(manager.listActive(nextContext)).toEqual(expect.arrayContaining([
      "read_files",
      "read_files",
      "search_in_files",
      "write_files",
      "patch_files",
    ]));
  });

  it("resolves and mounts only an explicitly selected file capability", () => {
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
    expect(manager.listActive(context)).toEqual([]);

    const capability = manager.resolveCapabilityTools(["file:create"]);
    expect(capability.missingCapabilities).toEqual([]);
    manager.replaceWithTools(
      capability.toolNames,
      context,
      deriveWorkstreamBindingCapabilityPolicy(runState),
    );
    const active = manager.listActive(context);
    expect(active).toEqual(expect.arrayContaining([
      "list_directory",
      "write_files",
      "create_directory",
    ]));
    expect(active).not.toContain("process_run");
    expect(active).not.toContain("workspace_get_state");
    expect(active).not.toContain("workspace_set_layout");
  });

  it("does not infer process capabilities from the request text", () => {
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
    expect(manager.listActive(context)).toEqual([]);

    const capability = manager.resolveCapabilityTools(["process:command"]);
    manager.replaceWithTools(
      capability.toolNames,
      context,
      deriveWorkstreamBindingCapabilityPolicy(runState),
    );
    expect(manager.listActive(context)).toEqual(["process_run"]);
  });

  it("never mounts hidden workstream lifecycle controls in the main loop", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("create durable work");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });
    expect(manager.listActive({ runId: "r1" })).toEqual([]);

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 2 });
    expect(manager.listActive({ runId: "r1" })).toEqual([]);

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 3 });
    expect(manager.listActive({ runId: "r1" })).toEqual([]);

    runState.completedSteps.push({
      step: 3,
      outcome: "completed",
      summary: "Workstream activated.",
      newFacts: [],
      artifacts: [],
      toolsUsed: ["git_context_activate_workstream"],
      toolSuccessCount: 1,
      toolFailureCount: 0,
    });
    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 4 });
    expect(manager.listActive({ runId: "r1" })).toEqual([]);
  });

  it("starts with no routing or mutation tools mounted at ENTRY", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_files"),
      ]),
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_find_workstreams"),
        tool("git_context_read_workstream"),
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
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

    expect(manager.listActive({ runId: "r1" })).toEqual([]);
  });

  it("mounts an explicit observation capability without mutation or routing tools", () => {
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
        tool("git_context_find_workstreams"),
        tool("git_context_read_workstream"),
        tool("git_context_read_evidence"),
        tool("git_context_search_evidence"),
        tool("git_context_log"),
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
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
    expect(manager.listActive(context)).toEqual([]);
    const capability = manager.resolveCapabilityTools(["file:search"]);
    manager.replaceWithTools(
      capability.toolNames,
      context,
      deriveWorkstreamBindingCapabilityPolicy(runState),
    );

    const active = manager.listActive(context);
    expect(active).toEqual(expect.arrayContaining(["find_files", "search_in_files"]));
    expect(active).not.toEqual(expect.arrayContaining([
      "write_files",
      "create_directory",
      "patch_files",
      "process_run",
      "git_context_activate_workstream",
      "git_context_create_workstream",
    ]));
    expect(executor.list(context)).toEqual(active);
  });

  it("does not infer ownership from a recent workstream", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_active"),
        tool("git_context_list_tasks"),
        tool("git_context_find_workstreams"),
        tool("git_context_read_workstream"),
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue the website");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithPendingTurn({
        status: "active",
        ref: "refs/heads/main",
        workstreamId: "W-20260702-0001",
      }, "unbound"),
    });

    manager.prepareForDecision(runState, { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });

    expect(manager.listActive({ runId: "r1" })).toEqual([]);
  });

  it("keeps mutation tools unavailable while workstream ownership is unbound", () => {
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
        tool("git_context_find_workstreams"),
        tool("git_context_read_workstream"),
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("write files, create a folder, run a command, and show where it is");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({
        status: "active",
        ref: "refs/heads/main",
        workstreamId: "W-20260702-0001",
      }),
    });
    const context = { clientId: "c1", runId: "decision:s1:1", sessionId: "s1", stepNumber: 1 };

    manager.prepareForDecision(runState, context);
    expect(manager.listActive(context)).toEqual([]);
    manager.replaceWithTools(
      ["find_files", "search_in_files", "read_files", "write_files", "create_directory", "process_run"],
      context,
      deriveWorkstreamBindingCapabilityPolicy(runState),
    );
    const active = manager.listActive(context);

    expect(active).toHaveLength(3);
    expect(active).toEqual(expect.arrayContaining(["find_files", "search_in_files", "read_files"]));
    expect(active).not.toContain("write_files");
    expect(active).not.toContain("create_directory");
    expect(active).not.toContain("process_run");
    expect(executor.list(context)).toEqual(active);
  });

  it("reports manual bound-only loads as unavailable before workstream binding", () => {
    const catalog = new ToolCatalog([
      skill("filesystem", [
        tool("write_files"),
      ]),
      skill("files", [
        tool("file_register_path"),
      ]),
      skill("git-context", [
        tool("git_context_inspect_resource"),
        tool("git_context_activate_workstream"),
        tool("git_context_create_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("Use /tmp/existing-project and build the requested website there");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };
    const policy = deriveWorkstreamBindingCapabilityPolicy(runState);

    manager.prepareForDecision(runState, context);
    const result = manager.load({
      toolNames: ["file_register_path", "write_files"],
    }, context, policy);

    expect(result).toMatchObject({
      status: "unavailable",
      loaded: [],
      alreadyActive: [],
      unavailable: [
        { tool: "file_register_path", reason: "requires_workstream_binding" },
        { tool: "write_files", reason: "requires_workstream_binding" },
      ],
    });
    expect(manager.listActive(context)).toEqual([]);
  });

  it("loads resource binding and rejects the pre-binding inspector after binding", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_inspect_resource"),
        tool("git_context_bind_resources"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("Bind the inspected resource to this workstream");
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    const result = manager.load({
      toolNames: ["git_context_inspect_resource", "git_context_bind_resources"],
    }, context, deriveWorkstreamBindingCapabilityPolicy(runState));

    expect(result).toMatchObject({
      status: "partial",
      loaded: ["git_context_bind_resources"],
      unavailable: [{
        tool: "git_context_inspect_resource",
        reason: "not_available_after_workstream_binding",
      }],
    });
    expect(manager.listActive(context)).toEqual(["git_context_bind_resources"]);
  });

  it("ignores a legacy routing execution record because those tools are never mounted", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_find_workstreams"),
        tool("git_context_create_workstream"),
        tool("git_context_activate_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const context = { clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 };

    const runState = state("build a website");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });
    manager.prepareForDecision(runState, context);
    manager.afterExecution([{
      callId: "call_1",
      tool: "git_context_create_workstream",
      input: {},
      output: "created workstream",
    }], context, deriveWorkstreamBindingCapabilityPolicy(runState));

    expect(manager.listActive(context)).toEqual([]);
  });

  it("does not re-add legacy routing tools from historical task steps", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_find_workstreams"),
        tool("git_context_create_workstream"),
        tool("git_context_activate_workstream"),
      ]),
    ]);
    const executor = createToolExecutor([]);
    const manager = new ToolWorkingSetManager({ catalog, toolExecutor: executor, maxVisibleTools: 12 });
    const runState = state("continue after workstream creation");
    runState.harnessContext = createInitialHarnessContext({
      contextEngine: contextEngineWithFocus({ status: "none" }),
    });
    runState.completedSteps = [{
      toolsUsed: ["git_context_create_workstream"],
    } as LoopState["completedSteps"][number]];

    manager.prepareForDecision(runState, { clientId: "c1", runId: "real-run", sessionId: "s1", stepNumber: 2 });

    expect(manager.listActive({ runId: "real-run" })).toEqual([]);
  });

  it("removes workstream-routing controls when the run is bound", () => {
    const catalog = new ToolCatalog([
      skill("git-context", [
        tool("git_context_create_workstream"),
        tool("git_context_activate_workstream"),
      ]),
      skill("filesystem", [
        tool("search_in_files"),
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
        "search_in_files",
        "git_context_create_workstream",
        "git_context_activate_workstream",
        "write_files",
      ],
    }, context, deriveWorkstreamBindingCapabilityPolicy(runState));
    manager.prepareForDecision(runState, context);

    expect(manager.listActive(context)).toEqual([
      "search_in_files",
      "write_files",
    ]);
  });
});

function contextEngineWithFocus(focus: ContextEngineMachineContext["focus"]): ContextEngineMachineContext {
  return {
    ...contextEngineFixture({ streamId: "s1", runId: "r1", message: "continue the website" }),
    focus,
  };
}

function contextEngineWithPendingTurn(
  focus: ContextEngineMachineContext["focus"],
  routingStatus: "unbound" | "bound" | "clarifying",
): ContextEngineMachineContext {
  return {
    ...contextEngineWithFocus(focus),
    current: {
      inputSeq: 1,
      runId: "r1",
      routing: {
        status: routingStatus,
        ...(routingStatus === "bound" ? { workstreamId: "W-1", requestId: "R-1" } : {}),
      },
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
