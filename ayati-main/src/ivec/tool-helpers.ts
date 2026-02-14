import type { LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolResult } from "../skills/types.js";

export const CONTEXT_RECALL_TOOL_NAME = "context_recall_agent";

export const CONTEXT_RECALL_TOOL_SCHEMA: LlmToolSchema = {
  name: CONTEXT_RECALL_TOOL_NAME,
  description:
    "Search prior sessions when you need historical context. Call only when active context is insufficient.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What historical context to retrieve from past sessions.",
      },
      searchQuery: {
        type: "string",
        description:
          "Optional compact keyword query to filter candidate sessions in SQLite.",
      },
    },
    required: ["query"],
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

export function toToolSchemas(executor: ToolExecutor | undefined): LlmToolSchema[] {
  const external = executor
    ? executor
        .definitions()
        .filter((tool) => !!tool.inputSchema)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        }))
    : [];

  if (external.some((tool) => tool.name === CONTEXT_RECALL_TOOL_NAME)) {
    return external;
  }

  return [...external, CONTEXT_RECALL_TOOL_SCHEMA];
}
