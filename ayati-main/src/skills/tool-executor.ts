import { devWarn } from "../shared/index.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; schema: Record<string, unknown> };

export interface ToolExecutor {
  list(): string[];
  definitions(): ToolDefinition[];
  execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult>;
  validate(toolName: string, input: unknown): ValidationResult;
}

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

function matchesType(value: unknown, expectedType: string): boolean {
  if (!JSON_SCHEMA_TYPES.has(expectedType)) return true;
  if (expectedType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expectedType === "array") return Array.isArray(value);
  return typeof value === expectedType;
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

    validate(toolName: string, input: unknown): ValidationResult {
      const tool = index.get(toolName);
      if (!tool) {
        return {
          valid: false,
          error: `Unknown tool: ${toolName}`,
          schema: { availableTools: [...index.keys()] },
        };
      }

      const schema = tool.inputSchema;
      if (!schema) return { valid: true };

      const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const required = (schema["required"] as string[] | undefined) ?? [];
      const properties = (schema["properties"] ?? {}) as Record<string, { type?: string }>;

      for (const field of required) {
        if (obj[field] === undefined || obj[field] === null) {
          return {
            valid: false,
            error: `Invalid input for '${toolName}': missing required field '${field}'`,
            schema: schema,
          };
        }
      }

      for (const [key, value] of Object.entries(obj)) {
        const propSchema = properties[key];
        if (propSchema?.type && !matchesType(value, propSchema.type)) {
          return {
            valid: false,
            error: `Invalid input for '${toolName}': field '${key}' expected type '${propSchema.type}', got '${typeof value}'`,
            schema: schema,
          };
        }
      }

      return { valid: true };
    },

    async execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
      const tool = index.get(toolName);
      if (!tool) {
        return { ok: false, error: `Unknown tool: ${toolName}` };
      }
      return tool.execute(input, context);
    },
  };
}
