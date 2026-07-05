import type { ToolDefinition } from "../../skills/types.js";
import type { ToolPhase, ToolTaxonomySummary } from "../../skills/tool-taxonomy.js";
import {
  getToolTaxonomy,
  isToolAllowedInPhase,
  summarizeToolTaxonomy,
} from "../../skills/tool-taxonomy.js";
import type { RuntimeCapabilityMode, RuntimeCapabilityModeName } from "./runtime-capability-mode.js";

export type ToolPolicyViolationCode =
  | "unknown_tool_taxonomy"
  | "mutation_tool_without_task_run"
  | "routing_mutation_after_task_bound"
  | "long_running_tool_without_task_run"
  | "tool_not_allowed_in_phase";

export type ToolPolicyViolationSeverity = "warning" | "error";

export interface ToolPolicyViolation {
  code: ToolPolicyViolationCode;
  severity: ToolPolicyViolationSeverity;
  tools: string[];
  message: string;
}

export interface ToolPolicyAudit {
  mode: RuntimeCapabilityModeName;
  phase: ToolPhase;
  hasWorkRun: boolean;
  selectedTools: string[];
  taxonomy: ToolTaxonomySummary;
  violations: ToolPolicyViolation[];
  warningCodes: ToolPolicyViolationCode[];
}

export function auditToolPolicy(input: {
  mode: RuntimeCapabilityMode;
  selectedTools: ToolDefinition[] | string[];
}): ToolPolicyAudit {
  const selectedTools = normalizeToolNames(input.selectedTools);
  const phase = phaseForRuntimeMode(input.mode, selectedTools);
  const violationMap = new Map<ToolPolicyViolationCode, ToolPolicyViolation>();

  for (const toolName of selectedTools) {
    const taxonomy = getToolTaxonomy(toolName);
    if (!taxonomy) {
      addViolation(violationMap, {
        code: "unknown_tool_taxonomy",
        severity: "error",
        tools: [toolName],
        message: "Selected tool is missing taxonomy metadata.",
      });
      continue;
    }

    if (!input.mode.hasWorkRun && taxonomy.requiresTaskRun) {
      addViolation(violationMap, {
        code: "mutation_tool_without_task_run",
        severity: "error",
        tools: [toolName],
        message: "A task-run-only mutation tool was selected before a task run exists.",
      });
    }

    if (!input.mode.hasWorkRun && isLongRunningTool(taxonomy)) {
      addViolation(violationMap, {
        code: "long_running_tool_without_task_run",
        severity: "error",
        tools: [toolName],
        message: "A long-running tool was selected before a task run exists.",
      });
    }

    if (isRoutingMutationAfterTaskBound(input.mode, taxonomy)) {
      addViolation(violationMap, {
        code: "routing_mutation_after_task_bound",
        severity: "error",
        tools: [toolName],
        message: "A task-routing mutation tool was selected after the turn is already bound to task work.",
      });
    }

    if (!isToolAllowedInPhase(toolName, phase)) {
      addViolation(violationMap, {
        code: "tool_not_allowed_in_phase",
        severity: "warning",
        tools: [toolName],
        message: `Selected tool is not declared for the ${phase} phase.`,
      });
    }
  }

  const violations = [...violationMap.values()];
  return {
    mode: input.mode.name,
    phase,
    hasWorkRun: input.mode.hasWorkRun,
    selectedTools,
    taxonomy: summarizeToolTaxonomy(selectedTools),
    violations,
    warningCodes: violations.map((violation) => violation.code),
  };
}

function normalizeToolNames(tools: ToolDefinition[] | string[]): string[] {
  return tools.map((tool) => typeof tool === "string" ? tool : tool.name);
}

function phaseForRuntimeMode(mode: RuntimeCapabilityMode, selectedTools: string[]): ToolPhase {
  if (mode.name === "task_run" || mode.hasWorkRun) {
    return "task_run";
  }
  if (mode.name === "fresh_session_routing" || mode.name === "pre_task_routing") {
    return "routing";
  }
  return selectedTools.length > 0 ? "enquiry" : "conversation";
}

function isRoutingMutationAfterTaskBound(
  mode: RuntimeCapabilityMode,
  taxonomy: NonNullable<ReturnType<typeof getToolTaxonomy>>,
): boolean {
  if (mode.name !== "task_run" && mode.pendingTurnStatus !== "bound") {
    return false;
  }
  return taxonomy.effect === "context_mutation" && taxonomy.roles.includes("task_routing");
}

function isLongRunningTool(taxonomy: NonNullable<ReturnType<typeof getToolTaxonomy>>): boolean {
  return taxonomy.lifetime === "background" || taxonomy.roles.includes("long_running_process");
}

function addViolation(
  violationMap: Map<ToolPolicyViolationCode, ToolPolicyViolation>,
  violation: ToolPolicyViolation,
): void {
  const existing = violationMap.get(violation.code);
  if (!existing) {
    violationMap.set(violation.code, violation);
    return;
  }
  existing.tools = uniqueStrings([...existing.tools, ...violation.tools]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
