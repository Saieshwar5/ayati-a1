import type { ToolDefinition } from "../skills/types.js";

/**
 * Builds a human-readable catalog of tools with names, descriptions, and parameters.
 * Used by the controller (to pick the right tool) and the reason phase (to plan approach).
 */
export function buildToolCatalog(toolDefinitions: ToolDefinition[]): string {
  if (toolDefinitions.length === 0) {
    return "Available tools: none";
  }

  const entries = toolDefinitions.map((tool) => {
    const params = formatParams(tool.inputSchema);
    return `  - ${tool.name}: ${tool.description}\n    Parameters: ${params}`;
  });

  return `Available tools (${toolDefinitions.length}):\n${entries.join("\n")}`;
}

function formatParams(schema?: Record<string, unknown>): string {
  if (!schema) return "none";

  const props = schema["properties"] as Record<string, { type?: string; description?: string }> | undefined;
  const required = (schema["required"] as string[] | undefined) ?? [];

  if (!props || Object.keys(props).length === 0) return "none";

  return Object.entries(props)
    .map(([key, val]) => {
      const type = val.type ?? "any";
      const req = required.includes(key) ? "required" : "optional";
      const desc = val.description ? ` — ${val.description}` : "";
      return `${key}: ${type} (${req})${desc}`;
    })
    .join(", ");
}
