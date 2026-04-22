import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import type { ExternalSkillBroker } from "../../../skills/external/broker.js";

interface SkillDeactivateInput {
  skillId?: string;
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

function createSkillListActiveTool(broker: ExternalSkillBroker): ToolDefinition {
  return {
    name: "skill_list_active",
    description: "List currently activated external skills and mounted typed external tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    selectionHints: {
      tags: ["external", "catalog", "list", "active"],
      aliases: ["list_active_external_skills"],
      examples: ["what external tools are active"],
      domain: "external",
      priority: 20,
    },
    async execute(_input, context?: ToolExecutionContext): Promise<ToolResult> {
      return jsonResult(broker.listActive(context));
    },
  };
}

function createSkillDeactivateTool(broker: ExternalSkillBroker): ToolDefinition {
  return {
    name: "skill_deactivate",
    description: "Deactivate one external skill or all active external skills for the current scope.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string" },
      },
    },
    selectionHints: {
      tags: ["external", "catalog", "deactivate", "cleanup"],
      aliases: ["unmount_external_skill", "remove_external_tools"],
      examples: ["deactivate gws-gmail", "clear active external tools"],
      domain: "external",
      priority: 18,
    },
    async execute(input, context?: ToolExecutionContext): Promise<ToolResult> {
      const payload = asObject(input) as SkillDeactivateInput;
      return jsonResult({
        removed: broker.deactivate(payload, context),
      });
    },
  };
}

function createSkillHealthTool(broker: ExternalSkillBroker): ToolDefinition {
  return {
    name: "skill_health",
    description: "Check readiness for one external skill or the whole external skill catalog, including secrets and dependency checks.",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string" },
      },
    },
    selectionHints: {
      tags: ["external", "health", "secrets", "dependencies"],
      aliases: ["check_external_skill_health", "skill_ready"],
      examples: ["check gws-gmail health", "show external skill readiness"],
      domain: "external",
      priority: 18,
    },
    async execute(input): Promise<ToolResult> {
      const payload = asObject(input);
      return jsonResult({
        skills: await broker.health(typeof payload.skillId === "string" ? payload.skillId : undefined),
      });
    },
  };
}

const SKILL_BROKER_PROMPT_BLOCK = [
  "External skill management helpers are built in.",
  "Available external skills are shown in the controller prompt as compact skill cards.",
  "Normal controller-driven activation uses the direct-stage activate_skill directive with the exact skill_id.",
  "After activation, call the mounted tools directly.",
  "Use skill_list_active to inspect which external skills are currently active.",
  "Use skill_deactivate to clear external tools you no longer need.",
  "Use skill_health only when a skill seems blocked or misconfigured.",
].join("\n");

export function createSkillBrokerSkill(broker: ExternalSkillBroker): SkillDefinition {
  return {
    id: "skill-broker",
    version: "2.0.0",
    description: "Activate and manage external skills and their mounted typed tools.",
    promptBlock: `${SKILL_BROKER_PROMPT_BLOCK}\n${broker.getPromptBlock()}`,
    tools: [
      createSkillListActiveTool(broker),
      createSkillDeactivateTool(broker),
      createSkillHealthTool(broker),
    ],
  };
}
