import { describe, expect, it } from "vitest";
import {
  CAPABILITY_DEFINITIONS,
  CapabilityCatalog,
} from "../../src/ivec/agent-runner/capabilities/catalog.js";
import { ToolRegistry } from "../../src/ivec/agent-runner/capabilities/registry.js";
import { buildModeTransitionControlTools } from "../../src/ivec/agent-runner/mode-transition-controls.js";
import type { VirtualModeTransitionTarget } from "../../src/ivec/agent-runner/virtual-mode.js";
import type { ToolDefinition } from "../../src/skills/types.js";

describe("capability catalog", () => {
  it("exposes small explicit responsibilities instead of overlapping inferred groups", () => {
    const catalog = new CapabilityCatalog();

    expect(catalog.get("file:search")).toMatchObject({
      coreTools: ["find_files", "list_directory", "search_in_files"],
      allowedModes: ["observe.locate"],
    });
    expect(catalog.get("file:read")).toMatchObject({
      coreTools: ["inspect_paths", "read_files"],
      allowedModes: ["observe.investigate"],
    });
    expect(catalog.get("file:write")).toMatchObject({
      coreTools: ["create_directory", "write_files", "patch_files"],
      allowedModes: ["resolve", "execute"],
    });
    expect(catalog.get("file:copy")).toMatchObject({
      coreTools: ["copy"],
      allowedModes: ["resolve", "execute"],
    });
    expect(catalog.get("file:permissions")).toMatchObject({
      coreTools: ["set_permissions"],
      allowedModes: ["resolve", "execute"],
    });
    expect(catalog.get("task:validation")).toMatchObject({
      coreTools: [],
      allowedModes: ["validation"],
    });
    expect(catalog.get("utility:calculator")).toMatchObject({
      coreTools: ["calculator"],
      allowedModes: ["observe.investigate"],
      targetRequirement: "none",
    });
    expect(catalog.get("system:time")).toMatchObject({
      coreTools: ["system_time"],
      allowedModes: ["observe.investigate"],
      targetRequirement: "none",
    });
    expect(catalog.get("system:health")).toMatchObject({
      coreTools: ["system_health"],
      allowedModes: ["observe.investigate"],
      targetRequirement: "none",
    });
    expect(catalog.get("workstream:search")).toMatchObject({
      coreTools: ["git_context_find_workstreams"],
      allowedModes: ["observe.locate"],
    });
    expect(catalog.get("workstream:read")).toMatchObject({
      coreTools: ["git_context_read_workstream"],
      allowedModes: ["observe.investigate"],
    });
    expect(catalog.get("workstream:history")).toMatchObject({
      coreTools: ["git_context_log", "git_context_show", "git_context_diff"],
      allowedModes: ["observe.locate", "observe.investigate"],
    });
    expect(catalog.get("resource:ownership")).toMatchObject({
      coreTools: ["git_context_find_resources"],
      allowedModes: ["observe.locate", "observe.investigate"],
    });
    expect(catalog.requiresReferenceTarget(["utility:calculator"])).toBe(false);
    expect(catalog.requiresReferenceTarget(["system:time"])).toBe(false);
    expect(catalog.requiresReferenceTarget(["utility:calculator", "file:read"]))
      .toBe(true);
    expect(catalog.requiresReferenceTarget(["system:time", "file:read"]))
      .toBe(true);
    expect(catalog.get("file:create")).toBeUndefined();
    expect(catalog.get("file:refactor")).toBeUndefined();
  });

  it("keeps hidden lifecycle tools out of every model-facing capability", () => {
    const tools = new CapabilityCatalog().list().flatMap((definition) => [
      ...definition.coreTools,
      ...(definition.optionalTools ?? []),
    ]);

    expect(tools).not.toContain("git_context_activate_workstream");
    expect(tools).not.toContain("git_context_create_workstream");
    expect(tools).not.toContain("git_context_inspect_resource");
  });

  it("validates complete ownership in one canonical tool registry", () => {
    const catalog = new CapabilityCatalog();
    const tools = uniqueTools(CAPABILITY_DEFINITIONS.flatMap((definition) => [
      ...definition.coreTools,
      ...(definition.optionalTools ?? []),
    ])).map(tool);
    const registry = new ToolRegistry(tools);

    expect(() => registry.assertCapabilityCoverage(catalog)).not.toThrow();
    expect(() => new ToolRegistry([tool("read_files"), tool("read_files")])).toThrow(
      "Duplicate tool name 'read_files'",
    );
    expect(() => new ToolRegistry([tool("unknown_tool")])).toThrow(
      "missing required safety taxonomy",
    );
  });

  it("builds destination-specific strict capability enums even with no active tools", () => {
    const options = new CapabilityCatalog().modeOptions();
    const tools = buildModeTransitionControlTools(options, allDestinations());
    const context = toolProperties(tools, "decision_enter_context_retrieve");
    const locate = toolProperties(tools, "decision_enter_observe_locate");
    const investigate = toolProperties(tools, "decision_enter_observe_investigate");
    const workstreamRoute = toolProperties(tools, "decision_enter_workstream_route");
    const resolveActivate = toolProperties(tools, "decision_resolve_activate");
    const resolveCreate = toolProperties(tools, "decision_resolve_create");
    const validation = toolProperties(tools, "decision_enter_validation");

    expect(capabilityEnum(context)).toEqual(["context:load"]);
    expect(capabilityEnum(locate)).toContain("file:search");
    expect(capabilityEnum(locate)).not.toContain("file:write");
    expect(capabilityEnum(investigate)).toContain("file:read");
    expect(capabilityEnum(investigate)).toContain("utility:calculator");
    expect(capabilityEnum(investigate)).toContain("system:time");
    expect(capabilityEnum(investigate)).toContain("system:health");
    expect(capabilityEnum(investigate)).not.toContain("file:write");
    expect(workstreamRoute).toHaveProperty("purpose");
    expect(workstreamRoute).not.toHaveProperty("capabilities");
    expect(workstreamRoute).not.toHaveProperty("subjects");
    expect(capabilityEnum(resolveActivate)).toContain("file:write");
    expect(capabilityEnum(resolveActivate)).toContain("file:copy");
    expect(capabilityEnum(resolveActivate)).toContain("file:permissions");
    expect(capabilityEnum(resolveActivate)).not.toContain("file:read");
    expect(capabilityEnum(validation)).toEqual(["task:validation"]);
    expect(validation).toHaveProperty("outcomeRefs");
    expect(validation).not.toHaveProperty("validationChecks");
    expect(JSON.stringify(validation)).toContain("context.run.verifiedOutcomes");
    expect(resolveActivate).not.toHaveProperty("references");
    expect(resolveActivate).not.toHaveProperty("mutationScopes");
    expect((resolveActivate["binding"] as Record<string, unknown>)["properties"]).toMatchObject({
      workstreamId: { type: "string" },
      resourceIds: {
        type: "array",
        minItems: 1,
        maxItems: 32,
      },
    });
    const createBindingProperties = (
      resolveCreate["binding"] as Record<string, unknown>
    )["properties"] as Record<string, unknown>;
    expect(createBindingProperties).toMatchObject({
      title: { type: "string" },
      objective: { type: "string" },
      initialRequest: { type: "object" },
    });
    expect(createBindingProperties).not.toHaveProperty("kind");
    expect(createBindingProperties).not.toHaveProperty("resources");
    expect(createBindingProperties).not.toHaveProperty("evidence");
    expect(resolveCreate["workspaceTargets"]).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
    });
    expect(resolveCreate).not.toHaveProperty("references");
    expect(resolveCreate).not.toHaveProperty("mutationScopes");
    expect((locate["capabilities"] as Record<string, unknown>)["maxItems"]).toBe(3);
    const investigateTool = tools.find(
      (tool) => tool.name === "decision_enter_observe_investigate",
    );
    expect(investigateTool?.inputSchema["required"]).toEqual([
      "purpose",
      "capabilities",
    ]);
    expect(tools.every((tool) => (
      tool.inputSchema["type"] === "object"
      && tool.inputSchema["oneOf"] === undefined
      && tool.inputSchema["additionalProperties"] === false
    ))).toBe(true);
  });

  it("omits destinations that are prohibited by the current virtual mode", () => {
    const tools = buildModeTransitionControlTools(
      new CapabilityCatalog().modeOptions(),
      ["observe.locate", "observe.investigate", "execute"],
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "decision_enter_observe_locate",
      "decision_enter_observe_investigate",
      "decision_enter_execute",
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain("decision_resolve_create");
  });
});

function toolProperties(
  tools: ReturnType<typeof buildModeTransitionControlTools>,
  name: string,
): Record<string, unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name} fixture.`);
  return tool.inputSchema["properties"] as Record<string, unknown>;
}

function capabilityEnum(properties: Record<string, unknown>): string[] {
  const capabilitySchema = properties["capabilities"] as Record<string, unknown>;
  const items = capabilitySchema["items"] as Record<string, unknown>;
  return items["enum"] as string[];
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

function uniqueTools(values: string[]): string[] {
  return [...new Set(values)];
}

function allDestinations(): VirtualModeTransitionTarget[] {
  return [
    "context.retrieve",
    "observe.locate",
    "observe.investigate",
    "workstream.route",
    "resolve",
    "execute",
    "validation",
  ];
}
