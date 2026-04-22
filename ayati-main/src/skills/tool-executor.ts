import { devWarn } from "../shared/index.js";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; schema: Record<string, unknown> };

export type ToolGroupScope = "static" | "session" | "run" | "step";

export interface ToolRegistryContext {
  clientId?: string;
  runId?: string;
  sessionId?: string;
  stepNumber?: number;
}

export interface ToolGroupMeta {
  scope: ToolGroupScope;
  clientId?: string;
  runId?: string;
  sessionId?: string;
  activatedAtStep?: number;
  expiresAfterStep?: number;
  skillId?: string;
  toolIds?: string[];
  description?: string;
}

export interface MountedToolGroup {
  groupId: string;
  tools: ToolDefinition[];
  meta: ToolGroupMeta;
}

export interface ToolExecutor {
  list(context?: ToolRegistryContext): string[];
  definitions(context?: ToolRegistryContext): ToolDefinition[];
  execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult>;
  validate(toolName: string, input: unknown, context?: ToolRegistryContext): ValidationResult;
  mount?(groupId: string, tools: ToolDefinition[], meta?: Partial<ToolGroupMeta>): void;
  unmount?(groupId: string): void;
  listMountedGroups?(context?: ToolRegistryContext): MountedToolGroup[];
  cleanupExpired?(context: ToolRegistryContext): string[];
}

function formatToolExecutionError(toolName: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Tool '${toolName}' threw an exception: ${message}`;
}

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

function matchesType(value: unknown, expectedType: string): boolean {
  if (!JSON_SCHEMA_TYPES.has(expectedType)) return true;
  if (expectedType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expectedType === "array") return Array.isArray(value);
  return typeof value === expectedType;
}

function normalizeGroupMeta(meta?: Partial<ToolGroupMeta>): ToolGroupMeta {
  return {
    scope: meta?.scope ?? "run",
    ...(meta?.clientId ? { clientId: meta.clientId } : {}),
    ...(meta?.runId ? { runId: meta.runId } : {}),
    ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(typeof meta?.activatedAtStep === "number" ? { activatedAtStep: meta.activatedAtStep } : {}),
    ...(typeof meta?.expiresAfterStep === "number" ? { expiresAfterStep: meta.expiresAfterStep } : {}),
    ...(meta?.skillId ? { skillId: meta.skillId } : {}),
    ...(meta?.toolIds ? { toolIds: [...meta.toolIds] } : {}),
    ...(meta?.description ? { description: meta.description } : {}),
  };
}

function isGroupVisible(meta: ToolGroupMeta, context?: ToolRegistryContext): boolean {
  if (meta.scope === "static") {
    return true;
  }

  if (meta.clientId && context?.clientId && meta.clientId !== context.clientId) {
    return false;
  }

  if (meta.scope === "session") {
    return !meta.sessionId || meta.sessionId === context?.sessionId;
  }

  if (meta.scope === "run" || meta.scope === "step") {
    if (meta.runId && meta.runId !== context?.runId) {
      return false;
    }
    if (meta.sessionId && meta.sessionId !== context?.sessionId) {
      return false;
    }
  }

  if (meta.scope === "step" && typeof meta.expiresAfterStep === "number" && typeof context?.stepNumber === "number") {
    return context.stepNumber <= meta.expiresAfterStep;
  }

  return true;
}

function shouldExpireGroup(meta: ToolGroupMeta, context: ToolRegistryContext): boolean {
  if (meta.scope !== "step") {
    return false;
  }

  if (meta.runId && meta.runId !== context.runId) {
    return false;
  }

  if (meta.sessionId && meta.sessionId !== context.sessionId) {
    return false;
  }

  if (typeof meta.expiresAfterStep !== "number" || typeof context.stepNumber !== "number") {
    return false;
  }

  return context.stepNumber >= meta.expiresAfterStep;
}

function buildVisibleIndex(
  groups: Map<string, MountedToolGroup>,
  context?: ToolRegistryContext,
): Map<string, ToolDefinition> {
  const index = new Map<string, ToolDefinition>();

  for (const group of groups.values()) {
    if (!isGroupVisible(group.meta, context)) {
      continue;
    }

    for (const tool of group.tools) {
      if (index.has(tool.name)) {
        devWarn(`Duplicate tool name detected, keeping first and skipping: ${tool.name}`);
        continue;
      }
      index.set(tool.name, tool);
    }
  }

  return index;
}

export function createToolExecutor(tools: ToolDefinition[]): ToolExecutor {
  const groups = new Map<string, MountedToolGroup>();

  groups.set("static:base", {
    groupId: "static:base",
    tools: [...tools],
    meta: { scope: "static", description: "Base built-in tool set" },
  });

  return {
    list(context?: ToolRegistryContext): string[] {
      return [...buildVisibleIndex(groups, context).keys()];
    },

    definitions(context?: ToolRegistryContext): ToolDefinition[] {
      return [...buildVisibleIndex(groups, context).values()];
    },

    validate(toolName: string, input: unknown, context?: ToolRegistryContext): ValidationResult {
      const tool = buildVisibleIndex(groups, context).get(toolName);
      if (!tool) {
        return {
          valid: false,
          error: `Unknown tool: ${toolName}`,
          schema: { availableTools: [...buildVisibleIndex(groups, context).keys()] },
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
            schema,
          };
        }
      }

      for (const [key, value] of Object.entries(obj)) {
        const propSchema = properties[key];
        if (propSchema?.type && !matchesType(value, propSchema.type)) {
          return {
            valid: false,
            error: `Invalid input for '${toolName}': field '${key}' expected type '${propSchema.type}', got '${typeof value}'`,
            schema,
          };
        }
      }

      return { valid: true };
    },

    async execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
      const tool = buildVisibleIndex(groups, context).get(toolName);
      if (!tool) {
        return { ok: false, error: `Unknown tool: ${toolName}` };
      }

      try {
        return await tool.execute(input, context);
      } catch (err) {
        return { ok: false, error: formatToolExecutionError(toolName, err) };
      }
    },

    mount(groupId: string, mountedTools: ToolDefinition[], meta?: Partial<ToolGroupMeta>): void {
      groups.set(groupId, {
        groupId,
        tools: [...mountedTools],
        meta: normalizeGroupMeta(meta),
      });
    },

    unmount(groupId: string): void {
      groups.delete(groupId);
    },

    listMountedGroups(context?: ToolRegistryContext): MountedToolGroup[] {
      return [...groups.values()]
        .filter((group) => isGroupVisible(group.meta, context))
        .map((group) => ({
          groupId: group.groupId,
          tools: [...group.tools],
          meta: { ...group.meta, ...(group.meta.toolIds ? { toolIds: [...group.meta.toolIds] } : {}) },
        }));
    },

    cleanupExpired(context: ToolRegistryContext): string[] {
      const removed: string[] = [];

      for (const [groupId, group] of groups.entries()) {
        if (!shouldExpireGroup(group.meta, context)) {
          continue;
        }
        groups.delete(groupId);
        removed.push(groupId);
      }

      return removed;
    },
  };
}
