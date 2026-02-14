import type { ToolDefinition } from "../skills/types.js";
import { CONTEXT_RECALL_TOOL_NAME } from "./tool-helpers.js";

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

const CONTEXT_RECALL_PARAMS = "query* (string), searchQuery (string)";

export function buildToolDirectory(tools: ToolDefinition[]): string {
  const rows: string[] = [];

  const hasContextRecall = tools.some((t) => t.name === CONTEXT_RECALL_TOOL_NAME);

  for (const tool of tools) {
    const params = buildParamSummary(tool.inputSchema);
    rows.push(`| ${tool.name} | ${tool.description} | ${params} |`);
  }

  if (!hasContextRecall) {
    rows.push(
      `| ${CONTEXT_RECALL_TOOL_NAME} | Search prior sessions when you need historical context | ${CONTEXT_RECALL_PARAMS} |`,
    );
  }

  if (rows.length === 0) return "";

  const header = "| Tool | Description | Parameters |\n|------|-------------|------------|";
  return `${header}\n${rows.join("\n")}`;
}
