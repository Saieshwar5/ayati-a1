import type { ToolDefinition } from "../../skills/types.js";
import type { ToolPhase, ToolTaxonomySummary } from "../../skills/tool-taxonomy.js";
import {
  getToolTaxonomy,
  isToolAllowedInPhase,
  summarizeToolTaxonomy,
} from "../../skills/tool-taxonomy.js";
import {
  toolPhaseForWorkstreamBinding,
  type WorkstreamBindingCapabilityPolicy,
} from "./workstream-binding-capability-policy.js";

export type ToolPolicyViolationCode =
  | "unknown_tool_taxonomy"
  | "mutation_tool_without_workstream_binding"
  | "routing_control_after_workstream_bound"
  | "long_running_tool_without_workstream_binding"
  | "tool_not_allowed_in_phase";

export type ToolPolicyViolationSeverity = "warning" | "error";

export interface ToolPolicyViolation {
  code: ToolPolicyViolationCode;
  severity: ToolPolicyViolationSeverity;
  tools: string[];
  message: string;
}

export interface ToolPolicyAudit {
  phase: ToolPhase;
  workstreamBound: boolean;
  selectedTools: string[];
  taxonomy: ToolTaxonomySummary;
  violations: ToolPolicyViolation[];
  warningCodes: ToolPolicyViolationCode[];
}

export function auditToolPolicy(input: {
  policy: WorkstreamBindingCapabilityPolicy;
  selectedTools: ToolDefinition[] | string[];
}): ToolPolicyAudit {
  const selectedTools = normalizeToolNames(input.selectedTools);
  const phase = toolPhaseForWorkstreamBinding(input.policy, selectedTools.length);
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

    if (!input.policy.workstreamBound && taxonomy.requiresWorkstreamBinding) {
      addViolation(violationMap, {
        code: "mutation_tool_without_workstream_binding",
        severity: "error",
        tools: [toolName],
        message: "A workstream-bound-only mutation tool was selected while the run was unbound.",
      });
    }

    if (!input.policy.workstreamBound && isLongRunningTool(taxonomy)) {
      addViolation(violationMap, {
        code: "long_running_tool_without_workstream_binding",
        severity: "error",
        tools: [toolName],
        message: "A long-running tool was selected while the run was unbound.",
      });
    }

    if (isRoutingControlAfterWorkstreamBound(input.policy, taxonomy)) {
      addViolation(violationMap, {
        code: "routing_control_after_workstream_bound",
        severity: "error",
        tools: [toolName],
        message: "A workstream-routing control was selected after the turn is already bound to workstream work.",
      });
    }

    if (!isToolAllowedInPhase(toolName, phase)
      && !isAvailableRoutingControl(input.policy, taxonomy)) {
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
    phase,
    workstreamBound: input.policy.workstreamBound,
    selectedTools,
    taxonomy: summarizeToolTaxonomy(selectedTools),
    violations,
    warningCodes: violations.map((violation) => violation.code),
  };
}

function normalizeToolNames(tools: ToolDefinition[] | string[]): string[] {
  return tools.map((tool) => typeof tool === "string" ? tool : tool.name);
}

function isRoutingControlAfterWorkstreamBound(
  policy: WorkstreamBindingCapabilityPolicy,
  taxonomy: NonNullable<ReturnType<typeof getToolTaxonomy>>,
): boolean {
  return policy.workstreamBound
    && taxonomy.purpose === "control"
    && taxonomy.roles.includes("workstream_routing");
}

function isAvailableRoutingControl(
  policy: WorkstreamBindingCapabilityPolicy,
  taxonomy: NonNullable<ReturnType<typeof getToolTaxonomy>>,
): boolean {
  return policy.routingAvailable
    && taxonomy.purpose === "control"
    && taxonomy.roles.includes("workstream_routing");
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
