import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import type { SkillActivationManager } from "../../activation-manager.js";

interface SkillDeactivateInput {
  skillId?: string;
}

interface SkillSearchInput {
  query?: string;
  limit?: number;
}

interface SkillActivateInput {
  skillId?: string;
  scope?: "step" | "run" | "session";
  reason?: string;
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function readRequiredString(input: Record<string, unknown>, key: string): string | ToolResult {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `Invalid input: ${key} must be a non-empty string.` };
  }
  return value.trim();
}

function jsonResult(value: unknown): ToolResult {
  return {
    ok: true,
    output: JSON.stringify(value, null, 2),
  };
}

function createSkillSearchTool(manager: SkillActivationManager): ToolDefinition {
  return {
    name: "skill_search",
    description: "Search compact built-in skill cards by task need before activating full tool schemas.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural language capability query." },
        limit: { type: "number", description: "Maximum results to return. Defaults to 5." },
      },
    },
    selectionHints: {
      tags: ["skill", "search", "catalog", "discover", "activate"],
      aliases: ["find_skill", "search_tools", "capability_search"],
      examples: ["find tools for pdf summary", "search database skill"],
      domain: "skills",
      priority: 35,
    },
    async execute(input): Promise<ToolResult> {
      const value = asObject(input);
      const payload = value as SkillSearchInput;
      const query = readRequiredString(value, "query");
      if (typeof query !== "string") {
        return query;
      }
      return jsonResult({
        results: await manager.search({
          query,
          limit: typeof payload.limit === "number" ? payload.limit : undefined,
        }),
      });
    },
  };
}

function createSkillDescribeTool(manager: SkillActivationManager): ToolDefinition {
  return {
    name: "skill_describe",
    description: "Describe one skill card and its tool summaries before activation.",
    inputSchema: {
      type: "object",
      required: ["skillId"],
      properties: {
        skillId: { type: "string", description: "Skill id to describe." },
      },
    },
    selectionHints: {
      tags: ["skill", "describe", "catalog", "tools"],
      aliases: ["inspect_skill", "show_skill"],
      examples: ["describe documents", "show database skill"],
      domain: "skills",
      priority: 30,
    },
    async execute(input): Promise<ToolResult> {
      const payload = asObject(input);
      const skillId = readRequiredString(payload, "skillId");
      if (typeof skillId !== "string") {
        return skillId;
      }
      const description = await manager.describe(skillId);
      if (!description) {
        return { ok: false, error: `Unknown skill: ${skillId}` };
      }
      return jsonResult({ skill: description });
    },
  };
}

function createSkillActivateTool(manager: SkillActivationManager): ToolDefinition {
  return {
    name: "skill_activate",
    description: "Activate one built-in skill so its full tool schemas become visible on the next decision step.",
    inputSchema: {
      type: "object",
      required: ["skillId"],
      properties: {
        skillId: { type: "string", description: "Skill id to activate." },
        scope: { type: "string", description: "Optional activation scope: step, run, or session. Defaults to the skill card scope." },
        reason: { type: "string", description: "Short reason for activation." },
      },
    },
    selectionHints: {
      tags: ["skill", "activate", "mount", "tools"],
      aliases: ["load_skill", "enable_skill", "mount_tools"],
      examples: ["activate documents", "load database tools"],
      domain: "skills",
      priority: 40,
    },
    async execute(input, context?: ToolExecutionContext): Promise<ToolResult> {
      const value = asObject(input);
      const payload = value as SkillActivateInput;
      const skillId = readRequiredString(value, "skillId");
      if (typeof skillId !== "string") {
        return skillId;
      }
      const result = await manager.activate({
        skillId,
        scope: payload.scope,
        reason: payload.reason,
      }, context);
      return result.ok ? jsonResult(result) : { ok: false, error: result.error ?? `Failed to activate skill: ${skillId}` };
    },
  };
}

function createSkillListActiveTool(manager: SkillActivationManager): ToolDefinition {
  return {
    name: "skill_list_active",
    description: "List currently activated dynamic skills and mounted typed tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    selectionHints: {
      tags: ["skill", "catalog", "list", "active"],
      aliases: ["list_active_skills"],
      examples: ["what dynamic tools are active"],
      domain: "skills",
      priority: 20,
    },
    async execute(_input, context?: ToolExecutionContext): Promise<ToolResult> {
      return jsonResult(manager.listActive(context));
    },
  };
}

function createSkillDeactivateTool(manager: SkillActivationManager): ToolDefinition {
  return {
    name: "skill_deactivate",
    description: "Deactivate one dynamic skill or all active dynamic skills for the current scope.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string" },
      },
    },
    selectionHints: {
      tags: ["skill", "catalog", "deactivate", "cleanup"],
      aliases: ["unmount_skill", "remove_dynamic_tools"],
      examples: ["deactivate documents", "clear active dynamic tools"],
      domain: "skills",
      priority: 18,
    },
    async execute(input, context?: ToolExecutionContext): Promise<ToolResult> {
      const payload = asObject(input) as SkillDeactivateInput;
      return jsonResult({
        removed: manager.deactivate(payload, context),
      });
    },
  };
}

const SKILL_BROKER_PROMPT_BLOCK = [
  "Dynamic skill management helpers are built in.",
  "Most non-kernel skills are shown as compact skill cards instead of always-visible full tool schemas.",
  "Use skill_search to find a matching skill when the needed capability is not currently active.",
  "Use skill_describe to inspect one skill before activation when the match is uncertain.",
  "Use skill_activate with the exact skillId to mount its full tool schemas for the current scope.",
  "After activation, call the mounted tools directly on the next decision step.",
  "Use skill_list_active to inspect currently active dynamic skills.",
  "Use skill_deactivate to clear dynamic tools you no longer need.",
].join("\n");

export function createSkillBrokerSkill(manager: SkillActivationManager): SkillDefinition {
  return {
    id: "skill-broker",
    version: "2.0.0",
    description: "Search, activate, and manage dynamic built-in skills.",
    promptBlock: `${SKILL_BROKER_PROMPT_BLOCK}\n\n${manager.getPromptBlock()}`,
    tools: [
      createSkillSearchTool(manager),
      createSkillDescribeTool(manager),
      createSkillActivateTool(manager),
      createSkillListActiveTool(manager),
      createSkillDeactivateTool(manager),
    ],
  };
}
