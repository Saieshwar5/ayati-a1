import type { SkillDefinition, ToolDefinition } from "../../../skills/types.js";
import { getToolTaxonomy } from "../../../skills/tool-taxonomy.js";
import type { CapabilityCatalog } from "./catalog.js";
import { HIDDEN_LIFECYCLE_TOOL_NAMES } from "./catalog.js";

export class ToolRegistry {
  private readonly toolsByName = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new Error(`Duplicate tool name '${tool.name}' in the canonical tool registry.`);
      }
      if (!getToolTaxonomy(tool.name)) {
        throw new Error(`Tool '${tool.name}' is missing required safety taxonomy.`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  static fromSkills(skills: SkillDefinition[]): ToolRegistry {
    return new ToolRegistry(skills.flatMap((skill) => skill.tools));
  }

  get(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.toolsByName.values()];
  }

  names(): string[] {
    return [...this.toolsByName.keys()];
  }

  nameSet(): ReadonlySet<string> {
    return new Set(this.toolsByName.keys());
  }

  assertCapabilityCoverage(catalog: CapabilityCatalog): void {
    const catalogTools = new Set(catalog.list().flatMap((definition) => [
      ...definition.coreTools,
      ...(definition.optionalTools ?? []),
    ]));
    const unknownCatalogTools = [...catalogTools]
      .filter((tool) => !this.toolsByName.has(tool))
      .sort();
    if (unknownCatalogTools.length > 0) {
      throw new Error(`Capability catalog references unregistered tools: ${unknownCatalogTools.join(", ")}.`);
    }

    const uncoveredTools = this.names()
      .filter((tool) => !HIDDEN_LIFECYCLE_TOOL_NAMES.has(tool))
      .filter((tool) => !catalogTools.has(tool))
      .sort();
    if (uncoveredTools.length > 0) {
      throw new Error(`Registered tools are missing capability ownership: ${uncoveredTools.join(", ")}.`);
    }

    const exposedHiddenTools = [...HIDDEN_LIFECYCLE_TOOL_NAMES]
      .filter((tool) => catalogTools.has(tool));
    if (exposedHiddenTools.length > 0) {
      throw new Error(`Hidden lifecycle tools cannot be model-facing: ${exposedHiddenTools.join(", ")}.`);
    }
  }
}
