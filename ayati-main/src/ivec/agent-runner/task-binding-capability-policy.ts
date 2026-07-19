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
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
  isGitContextAllowedDuringPendingRouting,
  isGitContextRoutingSupportToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type { LoopState } from "../types.js";
import type { AgentDecision } from "./decision.js";
import { isClearlyConversationOnlyRequest } from "./turn-intent-policy.js";

export interface TaskBindingCapabilityPolicy {
  taskBound: boolean;
  pendingTurnStatus?: string;
  routingSuppressed: boolean;
  routingAvailable: boolean;
  routingFailureLimitReached: boolean;
  allowToolLoading: boolean;
}

export interface CapabilityToolSummary {
  taskBound: boolean;
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

export function deriveTaskBindingCapabilityPolicy(
  state: LoopState,
): TaskBindingCapabilityPolicy {
  const pendingTurnStatus = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const taskBound = pendingTurnStatus === "bound";
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
  const routingAvailable = !taskBound
    && pendingTurnStatus !== "clarifying"
    && !routingSuppressed
    && !routingResolved
    && !routingFailureLimitReached;
  return {
    taskBound,
    ...(pendingTurnStatus ? { pendingTurnStatus } : {}),
    routingSuppressed,
    routingAvailable,
    routingFailureLimitReached,
    allowToolLoading: pendingTurnStatus !== "clarifying",
  };
}

export function isToolAllowedByTaskBinding(
  policy: TaskBindingCapabilityPolicy,
  toolName: string,
): boolean {
  const taxonomy = getToolTaxonomy(toolName);
  if (!taxonomy) return false;
  if (policy.taskBound) {
    return !isTaskRoutingControl(taxonomy) && !isGitContextRoutingSupportToolName(toolName);
  }
  if (isTaskRoutingControl(taxonomy)) {
    return policy.routingAvailable && taxonomy.canRunBeforeTask;
  }
  if (taxonomy.purpose === "control") {
    return taxonomy.canRunBeforeTask
      && isGitContextAllowedDuringPendingRouting(toolName)
      && policy.pendingTurnStatus !== "clarifying";
  }
  if (taxonomy.purpose === "mutation" || taxonomy.effect !== "read_only") return false;
  return taxonomy.purpose === "list"
    || taxonomy.purpose === "read"
    || taxonomy.purpose === "search";
}

export function filterToolsByTaskBinding(
  policy: TaskBindingCapabilityPolicy,
  tools: ToolDefinition[],
): ToolDefinition[] {
  return tools.filter((tool) => isToolAllowedByTaskBinding(policy, tool.name));
}

export function toolPhaseForTaskBinding(
  policy: TaskBindingCapabilityPolicy,
  selectedToolCount = 0,
): ToolPhase {
  if (policy.taskBound) return "task_bound";
  if (policy.routingAvailable) return "routing";
  return selectedToolCount > 0 ? "enquiry" : "conversation";
}

export function requiredRoutingControls(
  policy: TaskBindingCapabilityPolicy,
  state: LoopState,
): string[] {
  if (!policy.routingAvailable) return [];
  return state.harnessContext.contextEngine?.focus.status === "none"
    ? [...GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES]
    : [...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES];
}

export function deterministicToolsForTaskBinding(
  policy: TaskBindingCapabilityPolicy,
): string[] | undefined {
  if (policy.pendingTurnStatus === "clarifying") return [];
  return undefined;
}

export function isDecisionAllowedByTaskBinding(
  policy: TaskBindingCapabilityPolicy,
  decision: AgentDecision,
): boolean {
  if (decision.kind === "reply") return true;
  if (decision.kind === "load_tools") return policy.allowToolLoading;
  if (decision.kind !== "act" || decision.action.calls.length === 0) return false;
  return decision.action.calls.every((call) => isToolAllowedByTaskBinding(policy, call.tool))
    && decision.action.allowedTools.every((tool) => isToolAllowedByTaskBinding(policy, tool));
}

export function summarizeCapabilityTools(input: {
  policy: TaskBindingCapabilityPolicy;
  visibleTools: ToolDefinition[];
  selectedTools: ToolDefinition[];
}): CapabilityToolSummary {
  const visible = input.visibleTools.map((tool) => tool.name);
  const selected = input.selectedTools.map((tool) => tool.name);
  return {
    taskBound: input.policy.taskBound,
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
  const policy = deriveTaskBindingCapabilityPolicy(state);
  return isToolAllowedByTaskBinding(policy, toolName)
    && isToolAllowedInPhase(toolName, toolPhaseForTaskBinding(policy, 1));
}

function isTaskRoutingControl(taxonomy: ToolTaxonomyEntry): boolean {
  return taxonomy.purpose === "control" && taxonomy.roles.includes("task_routing");
}
