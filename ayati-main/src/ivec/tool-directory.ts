import type { ToolDefinition } from "../skills/types.js";
import {
  CREATE_SESSION_TOOL_NAME,
} from "./tool-helpers.js";

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

const CREATE_SESSION_PARAMS = "reason* (string), confidence (number), handoff_summary (string)";

export function buildToolDirectory(tools: ToolDefinition[]): string {
  const rows: string[] = [];

  const hasCreateSession = tools.some((t) => t.name === CREATE_SESSION_TOOL_NAME);

  for (const tool of tools) {
    const params = buildParamSummary(tool.inputSchema);
    rows.push(`| ${tool.name} | ${tool.description} | ${params} |`);
  }

  if (!hasCreateSession) {
    rows.push(
      `| ${CREATE_SESSION_TOOL_NAME} | Close current active session and open a new one atomically when user switches to a different goal. | ${CREATE_SESSION_PARAMS} |`,
    );
  }

  if (rows.length === 0) return "";

  const header = "| Tool | Description | Parameters |\n|------|-------------|------------|";
  return `${header}\n${rows.join("\n")}`;
}
