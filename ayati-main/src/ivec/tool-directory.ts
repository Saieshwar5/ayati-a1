import type { ToolDefinition } from "../skills/types.js";

interface SchemaProperties {
  [key: string]: { type?: string; description?: string };
}

function formatParam(name: string, prop: { type?: string } | undefined, isRequired: boolean): string {
  const type = prop?.type ?? "any";
  return isRequired ? `${name}* (${type})` : `${name} (${type})`;
}

function buildParamSummary(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "";
  const properties = (schema["properties"] ?? {}) as SchemaProperties;
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  const entries = Object.entries(properties);
  if (entries.length === 0) return "";
  return entries.map(([name, prop]) => formatParam(name, prop, required.has(name))).join(", ");
}

export function buildToolDirectory(tools: ToolDefinition[]): string {
  const rows: string[] = [];

  for (const tool of tools) {
    const params = buildParamSummary(tool.inputSchema);
    rows.push(`| ${tool.name} | ${tool.description} | ${params} |`);
  }

  if (rows.length === 0) return "";

  const header = "| Tool | Description | Parameters |\n|------|-------------|------------|";
  return `${header}\n${rows.join("\n")}`;
}
