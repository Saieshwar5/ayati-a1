import type { ToolResult } from "../skills/types.js";
import type { LlmToolSchema } from "../core/contracts/llm-protocol.js";

export const CONTEXT_RECALL_TOOL_NAME = "context_recall_agent";
export const CONTEXT_RECALL_TOOL_SCHEMA: LlmToolSchema = {
  name: CONTEXT_RECALL_TOOL_NAME,
  description: "Search prior sessions when historical context is needed.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Question to search in prior sessions.",
      },
      searchQuery: {
        type: "string",
        description: "Optional keyword-focused query used for retrieval.",
      },
    },
  },
};

export function formatToolResult(toolName: string, result: ToolResult): string {
  return JSON.stringify(
    {
      tool: toolName,
      ok: result.ok,
      output: result.output ?? "",
      error: result.error ?? "",
      meta: result.meta ?? {},
    },
    null,
    2,
  );
}

export function formatValidationError(
  toolName: string,
  validationError: string,
  schema?: Record<string, unknown>,
): string {
  const lines: string[] = [
    `Tool '${toolName}' input validation failed: ${validationError}`,
  ];

  if (schema) {
    const properties = schema["properties"] as Record<string, unknown> | undefined;
    const required = schema["required"] as string[] | undefined;

    if (properties) {
      lines.push("");
      lines.push(`Required schema for '${toolName}':`);
      lines.push(JSON.stringify(properties, null, 2));
    }

    if (required && required.length > 0) {
      lines.push("");
      lines.push(`Required fields: ${required.join(", ")}`);
    }
  }

  return lines.join("\n");
}
