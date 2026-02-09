import { devWarn } from "../shared/index.js";
import { canUseTool } from "./access-policy.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";

export interface ToolExecutor {
  list(): string[];
  definitions(): ToolDefinition[];
  execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult>;
}

export function createToolExecutor(tools: ToolDefinition[]): ToolExecutor {
  const index = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    if (index.has(tool.name)) {
      devWarn(`Duplicate tool name detected, keeping first and skipping: ${tool.name}`);
      continue;
    }
    index.set(tool.name, tool);
  }

  return {
    list(): string[] {
      return [...index.keys()];
    },

    definitions(): ToolDefinition[] {
      return [...index.values()];
    },

    async execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
      const tool = index.get(toolName);
      if (!tool) {
        return { ok: false, error: `Unknown tool: ${toolName}` };
      }
      const access = canUseTool(toolName);
      if (!access.allowed) {
        return { ok: false, error: access.reason ?? `Tool access denied: ${toolName}` };
      }
      return tool.execute(input, context);
    },
  };
}
