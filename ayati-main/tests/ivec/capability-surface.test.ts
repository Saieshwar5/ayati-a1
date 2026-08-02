import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../../src/ivec/agent-runner/capabilities/catalog.js";
import { ToolRegistry } from "../../src/ivec/agent-runner/capabilities/registry.js";
import { CapabilitySurfaceManager } from "../../src/ivec/agent-runner/capabilities/surface-manager.js";
import { resolveCapabilitySurface } from "../../src/ivec/agent-runner/capabilities/surface-resolver.js";
import { createEntryVirtualModeState } from "../../src/ivec/agent-runner/virtual-mode.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { LoopState } from "../../src/ivec/types.js";

describe("capability surface resolution", () => {
  it("loads proof-only validation with no executable tools", () => {
    const result = resolve([], {
      capabilities: ["task:validation"],
      mode: "validation",
      maxVisibleTools: 8,
    });

    expect(result).toMatchObject({
      status: "loaded",
      capabilities: ["task:validation"],
      loaded: [],
      coverage: [{
        capability: "task:validation",
        coreTools: [],
      }],
    });
  });

  it("keeps every core tool for an accepted capability", () => {
    const result = resolve(["create_directory", "write_files", "patch_files"], {
      capabilities: ["file:write"],
      mode: "resolve",
      maxVisibleTools: 3,
    });

    expect(result).toMatchObject({
      status: "loaded",
      loaded: ["create_directory", "write_files", "patch_files"],
      omittedOptionalTools: [],
    });
    expect(result.coverage).toEqual([{
      capability: "file:write",
      coreTools: ["create_directory", "write_files", "patch_files"],
      optionalTools: [],
      omittedOptionalTools: [],
    }]);
  });

  it("fails explicitly when core coverage cannot fit", () => {
    const result = resolve(["create_directory", "write_files", "patch_files"], {
      capabilities: ["file:write"],
      mode: "resolve",
      maxVisibleTools: 2,
    });

    expect(result).toMatchObject({
      status: "surface_too_large",
      loaded: [],
      missing: [
        "create_directory (core coverage)",
        "write_files (core coverage)",
        "patch_files (core coverage)",
      ],
    });
  });

  it("reports optional tools omitted by the bounded surface", () => {
    const tools = [
      "attachment_read",
      "file_read_text",
      "directory_search",
      "attachment_query",
      "file_describe",
      "file_query",
    ];
    const result = resolve(tools, {
      capabilities: ["attachment:read"],
      mode: "observe.investigate",
      maxVisibleTools: 4,
    });

    expect(result.status).toBe("partial");
    expect(result.loaded).toEqual([
      "attachment_read",
      "file_read_text",
      "directory_search",
      "attachment_query",
    ]);
    expect(result.omittedOptionalTools).toEqual(["file_describe", "file_query"]);
    expect(result.message).toContain("Optional tools omitted");
  });

  it("rejects capabilities that are not valid for the destination mode", () => {
    const result = resolve(["create_directory", "write_files", "patch_files"], {
      capabilities: ["file:write"],
      mode: "observe.investigate",
      maxVisibleTools: 8,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      loaded: [],
      unavailableCapabilities: [{
        capability: "file:write",
        reason: "mode_not_allowed",
      }],
    });
  });

  it("replaces the complete native surface without a second selector", () => {
    const definitions = [
      tool("find_files"),
      tool("list_directory"),
      tool("search_in_files"),
      tool("inspect_paths"),
      tool("read_files"),
    ];
    const executor = createToolExecutor([]);
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry(definitions),
      toolExecutor: executor,
      validateCoverage: false,
    });
    const current = state();
    const context = { runId: current.runId, stepNumber: 1 };

    const locate = manager.replaceWithCapabilities({
      capabilities: ["file:search"],
      mode: "observe.locate",
      state: current,
      context,
    });
    expect(locate.loaded).toEqual(["find_files", "list_directory", "search_in_files"]);
    expect(executor.list(context)).toEqual(["find_files", "list_directory", "search_in_files"]);

    const investigate = manager.replaceWithCapabilities({
      capabilities: ["file:read"],
      mode: "observe.investigate",
      state: current,
      context: { ...context, stepNumber: 2 },
    });
    expect(investigate.evicted).toEqual(["find_files", "list_directory", "search_in_files"]);
    expect(executor.list(context)).toEqual(["inspect_paths", "read_files"]);
  });

  it("projects capability options from the current mode authority", () => {
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry([
        tool("git_context_find_workstreams"),
        tool("git_context_read_workstream"),
        tool("create_directory"),
        tool("write_files"),
        tool("patch_files"),
      ]),
      toolExecutor: createToolExecutor([]),
      validateCoverage: false,
    });

    const unbound = manager.getModeCapabilityOptions(state());
    expect(unbound["observe.locate"]).toContain("workstream:search");
    expect(unbound["observe.investigate"]).toContain("workstream:read");
    expect(unbound["workstream.route"]).toEqual([]);
    expect(unbound.resolve).toContain("file:write");
    expect(unbound.execute).not.toContain("file:write");

    const bound = manager.getModeCapabilityOptions(state(true));
    expect(bound["observe.locate"]).not.toContain("workstream:search");
    expect(bound["workstream.route"]).not.toContain("workstream:search");
    expect(bound.execute).toContain("file:write");
  });

  it("offers context retrieval only while an unloaded entry is available", () => {
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry([tool("context_load")]),
      toolExecutor: createToolExecutor([]),
      validateCoverage: false,
    });
    const current = state();

    expect(manager.getModeCapabilityOptions(current)["context.retrieve"]).toEqual([]);

    current.hotContext.available = [{
      key: "personal.memory",
      description: "Stable personal preferences.",
      version: "1",
      estimatedTokens: 10,
      freshness: "current",
      sourceRefs: ["personal-memory:snapshot"],
    }];

    expect(manager.getModeCapabilityOptions(current)["context.retrieve"]).toEqual([
      "context:load",
    ]);
  });

  it("clears the complete surface when authority changes", () => {
    const executor = createToolExecutor([]);
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry([tool("git_context_find_workstreams")]),
      toolExecutor: executor,
      validateCoverage: false,
    });
    const unbound = state();
    const context = { runId: unbound.runId, stepNumber: 1 };

    manager.replaceWithCapabilities({
      capabilities: ["workstream:search"],
      mode: "observe.locate",
      state: unbound,
      context,
    });
    const bound = state(true);
    bound.virtualMode = {
      active: "observe.locate",
      revision: 1,
      capabilities: ["workstream:search"],
      targets: [],
    };
    const result = manager.prepareForDecision(bound, {
      ...context,
      stepNumber: 2,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      evicted: ["git_context_find_workstreams"],
    });
    expect(manager.listActiveCapabilities(context)).toEqual([]);
    expect(executor.list(context)).toEqual([]);
  });

  it("clears a surface whose core coverage no longer fits under pressure", () => {
    const tools = [
      "db_list_tables",
      "db_describe_table",
      "db_get_table_ddl",
      "db_query",
      "dataset_profile",
      "dataset_query",
      "python_inspect_dataset",
    ];
    const executor = createToolExecutor([]);
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry(tools.map(tool)),
      toolExecutor: executor,
      validateCoverage: false,
    });
    const current = state();
    current.virtualMode = {
      active: "observe.investigate",
      revision: 1,
      capabilities: ["database:read", "dataset:inspect"],
      targets: [],
    };
    const context = { runId: current.runId, stepNumber: 1 };

    manager.replaceWithCapabilities({
      capabilities: ["database:read", "dataset:inspect"],
      mode: "observe.investigate",
      state: current,
      context,
    });
    current.contextPressure = {
      mode: "tool_compact",
      softLimitBreachCount: 1,
      unresolvedPressureStreak: 1,
      successfulRecoveryCount: 0,
      admissionRejectionCount: 0,
      peakCandidateInputTokens: 70_000,
    };
    const result = manager.prepareForDecision(current, {
      ...context,
      stepNumber: 2,
    });

    expect(result.status).toBe("surface_too_large");
    expect(result.evicted.length).toBeGreaterThan(0);
    expect(manager.listActiveCapabilities(context)).toEqual([]);
  });
});

function resolve(
  names: string[],
  input: {
    capabilities: string[];
    mode: "observe.locate" | "observe.investigate" | "resolve" | "execute";
    maxVisibleTools: number;
  },
) {
  return resolveCapabilitySurface({
    catalog: new CapabilityCatalog(),
    registry: new ToolRegistry(names.map(tool)),
    capabilities: input.capabilities,
    mode: input.mode,
    maxVisibleTools: input.maxVisibleTools,
    policy: {
      workstreamBound: input.mode === "execute",
      routingAvailable: true,
    },
  });
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    async execute() {
      return { ok: true, output: "ok" };
    },
  };
}

function state(bound = false): LoopState {
  return {
    runId: "R-capability-surface",
    currentSeq: 1,
    userMessage: "Inspect files.",
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 10,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "/tmp/R-capability-surface",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    hotContext: {
      available: [],
      loaded: [],
      budget: { maxMountedTokens: 8_000, mountedTokens: 0 },
    },
    harnessContext: {
      contextEngine: {
        current: {
          runId: "R-capability-surface",
          inputSeq: 1,
          routing: bound
            ? {
                status: "bound",
                workstreamId: "W-20260723-0001",
                requestId: "REQ-20260723-0001",
              }
            : { status: "unbound" },
        },
      } as never,
    },
  };
}
