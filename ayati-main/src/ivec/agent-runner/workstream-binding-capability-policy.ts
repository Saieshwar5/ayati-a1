import type { ToolDefinition } from "../../skills/types.js";
import {
  getToolPurpose,
  getToolTaxonomy,
  isToolAllowedInPhase,
  type ToolPhase,
  type ToolTaxonomyEntry,
} from "../../skills/tool-taxonomy.js";
import {
  GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES,
  GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
  isGitContextBoundResourceToolName,
  isGitContextAllowedDuringPendingRouting,
  isGitContextRoutingSupportToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type { LoopState } from "../types.js";
import type { AgentDecision } from "./decision.js";
import { isClearlyConversationOnlyRequest } from "./turn-intent-policy.js";

export interface WorkstreamBindingCapabilityPolicy {
  workstreamBound: boolean;
  pendingTurnStatus?: string;
  routingSuppressed: boolean;
  routingAvailable: boolean;
  routingFailureLimitReached: boolean;
  allowToolLoading: boolean;
}

export interface CapabilityToolSummary {
  workstreamBound: boolean;
  pendingTurnStatus?: string;
  routingSuppressed: boolean;
  routingAvailable: boolean;
  visibleRoutingTools: string[];
  selectedRoutingTools: string[];
  visibleReadTools: string[];
  selectedReadTools: string[];
  visibleSearchTools: string[];
  selectedSearchTools: string[];
  visibleControlTools: string[];
  selectedControlTools: string[];
  visibleMutationTools: string[];
  selectedMutationTools: string[];
  visibleToolCount: number;
  selectedToolCount: number;
}

export function deriveWorkstreamBindingCapabilityPolicy(
  state: LoopState,
): WorkstreamBindingCapabilityPolicy {
  const pendingTurnStatus = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const workstreamBound = pendingTurnStatus === "bound";
  const routingSuppressed = state.inputKind === "user_message"
    && isClearlyConversationOnlyRequest(state.userMessage);
  const attempts = state.routingAttempts ?? {
    successCount: 0,
    failureCount: 0,
    maxFailures: 2,
    resolved: false,
  };
  const routingFailureLimitReached = attempts.failureCount >= attempts.maxFailures;
  const routingResolved = attempts.resolved
    || attempts.successCount > 0
    || state.completedSteps.some((step) =>
      step.outcome !== "failed"
      && (step.toolsUsed ?? []).some(isGitContextTurnRoutingToolName));
  const routingAvailable = !workstreamBound
    && pendingTurnStatus !== "clarifying"
    && !routingSuppressed
    && !routingResolved
    && !routingFailureLimitReached;
  return {
    workstreamBound,
    ...(pendingTurnStatus ? { pendingTurnStatus } : {}),
    routingSuppressed,
    routingAvailable,
    routingFailureLimitReached,
    allowToolLoading: pendingTurnStatus !== "clarifying",
  };
}

export function isToolAllowedByWorkstreamBinding(
  policy: WorkstreamBindingCapabilityPolicy,
  toolName: string,
): boolean {
  const taxonomy = getToolTaxonomy(toolName);
  if (!taxonomy) return false;
  if (policy.workstreamBound) {
    if (isGitContextBoundResourceToolName(toolName)) return true;
    return !isWorkstreamRoutingControl(taxonomy) && !isGitContextRoutingSupportToolName(toolName);
  }
  if (isWorkstreamRoutingControl(taxonomy)) {
    return policy.routingAvailable && taxonomy.canRunBeforeWorkstream;
  }
  if (taxonomy.purpose === "control") {
    return taxonomy.canRunBeforeWorkstream
      && isGitContextAllowedDuringPendingRouting(toolName)
      && policy.pendingTurnStatus !== "clarifying";
  }
  if (taxonomy.purpose === "mutation" || taxonomy.effect !== "read_only") return false;
  return taxonomy.purpose === "list"
    || taxonomy.purpose === "read"
    || taxonomy.purpose === "search";
}

export function filterToolsByWorkstreamBinding(
  policy: WorkstreamBindingCapabilityPolicy,
  tools: ToolDefinition[],
): ToolDefinition[] {
  return tools.filter((tool) => isToolAllowedByWorkstreamBinding(policy, tool.name));
}

export function toolPhaseForWorkstreamBinding(
  policy: WorkstreamBindingCapabilityPolicy,
  selectedToolCount = 0,
): ToolPhase {
  if (policy.workstreamBound) return "workstream_bound";
  if (policy.routingAvailable) return "routing";
  return selectedToolCount > 0 ? "enquiry" : "conversation";
}

export function requiredRoutingControls(
  policy: WorkstreamBindingCapabilityPolicy,
  state: LoopState,
): string[] {
  if (!policy.routingAvailable) return [];
  return state.harnessContext.contextEngine?.focus.status === "none"
    ? [...GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES]
    : [
        ...GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES,
        ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
      ];
}

export function deterministicToolsForWorkstreamBinding(
  policy: WorkstreamBindingCapabilityPolicy,
): string[] | undefined {
  if (policy.pendingTurnStatus === "clarifying") return [];
  return undefined;
}

export function isDecisionAllowedByWorkstreamBinding(
  policy: WorkstreamBindingCapabilityPolicy,
  decision: AgentDecision,
): boolean {
  if (decision.kind === "reply") return true;
  if (decision.kind === "load_tools") return policy.allowToolLoading;
  if (decision.kind !== "act" || decision.action.calls.length === 0) return false;
  return decision.action.calls.every((call) => isToolAllowedByWorkstreamBinding(policy, call.tool))
    && decision.action.allowedTools.every((tool) => isToolAllowedByWorkstreamBinding(policy, tool));
}

export function summarizeCapabilityTools(input: {
  policy: WorkstreamBindingCapabilityPolicy;
  visibleTools: ToolDefinition[];
  selectedTools: ToolDefinition[];
}): CapabilityToolSummary {
  const visible = input.visibleTools.map((tool) => tool.name);
  const selected = input.selectedTools.map((tool) => tool.name);
  return {
    workstreamBound: input.policy.workstreamBound,
    ...(input.policy.pendingTurnStatus
      ? { pendingTurnStatus: input.policy.pendingTurnStatus }
      : {}),
    routingSuppressed: input.policy.routingSuppressed,
    routingAvailable: input.policy.routingAvailable,
    visibleRoutingTools: visible.filter(isGitContextRoutingToolName),
    selectedRoutingTools: selected.filter(isGitContextRoutingToolName),
    visibleReadTools: visible.filter((tool) => getToolPurpose(tool) === "read"),
    selectedReadTools: selected.filter((tool) => getToolPurpose(tool) === "read"),
    visibleSearchTools: visible.filter((tool) => getToolPurpose(tool) === "search"),
    selectedSearchTools: selected.filter((tool) => getToolPurpose(tool) === "search"),
    visibleControlTools: visible.filter((tool) => getToolPurpose(tool) === "control"),
    selectedControlTools: selected.filter((tool) => getToolPurpose(tool) === "control"),
    visibleMutationTools: visible.filter((tool) => getToolPurpose(tool) === "mutation"),
    selectedMutationTools: selected.filter((tool) => getToolPurpose(tool) === "mutation"),
    visibleToolCount: visible.length,
    selectedToolCount: selected.length,
  };
}

export function isGitContextRoutingToolName(tool: string): boolean {
  return isGitContextAllowedDuringPendingRouting(tool);
}

export function isToolAvailableInDerivedPhase(
  state: LoopState,
  toolName: string,
): boolean {
  const policy = deriveWorkstreamBindingCapabilityPolicy(state);
  return isToolAllowedByWorkstreamBinding(policy, toolName)
    && isToolAllowedInPhase(toolName, toolPhaseForWorkstreamBinding(policy, 1));
}

function isWorkstreamRoutingControl(taxonomy: ToolTaxonomyEntry): boolean {
  return taxonomy.purpose === "control" && taxonomy.roles.includes("workstream_routing");
}
