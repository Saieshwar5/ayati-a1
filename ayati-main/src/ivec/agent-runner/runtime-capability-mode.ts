import type { MemoryRunHandle } from "../../memory/types.js";
import type { ToolDefinition } from "../../skills/types.js";
import {
  GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES,
  GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
  isGitContextAllowedDuringPendingRouting,
  isGitContextFreshSessionRoutingToolName,
  isGitContextReadOnlyToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type { LoopState } from "../types.js";
import type { AgentDecision } from "./decision.js";
import type { RepairCode } from "./repair-policy.js";

export type RuntimeCapabilityModeName =
  | "task_run"
  | "fresh_session_routing"
  | "pre_task_routing"
  | "session_only";

export interface RuntimeCapabilityMode {
  name: RuntimeCapabilityModeName;
  primary: true;
  hasWorkRun: boolean;
  focusStatus?: string;
  pendingTurnStatus?: string;
  whyActive: string;
  allowedActions: string[];
  blockedCapabilities: string[];
  next: string;
  rules?: string[];
  repairCode?: RepairCode;
  allowToolLoading: boolean;
  routingWindow?: RuntimeCapabilityRoutingWindow;
}

export interface RuntimeCapabilityRoutingWindow {
  open: boolean;
  expired?: boolean;
  step: number;
  maxSteps: number;
  remaining: number;
  expiresAfterThisDecision: boolean;
  readToolsAvailable: boolean;
  routingToolsAvailable: boolean;
  readToolsRemainAfterExpiry: boolean;
  guidance: string;
}

export interface RuntimeCapabilityPromptContext {
  name: RuntimeCapabilityModeName;
  why: string;
  allowed: string[];
  blocked: string[];
  next: string;
  rules?: string[];
  repairCode?: RepairCode;
  routingWindow?: RuntimeCapabilityRoutingWindow;
}

export interface RuntimeCapabilityToolSummary {
  mode: RuntimeCapabilityModeName;
  hasWorkRun: boolean;
  focusStatus?: string;
  pendingTurnStatus?: string;
  visibleRoutingTools: string[];
  selectedRoutingTools: string[];
  visibleNormalTools: string[];
  selectedNormalTools: string[];
  visibleReadTools: string[];
  selectedReadTools: string[];
  visibleTaskRoutingTools: string[];
  selectedTaskRoutingTools: string[];
  visibleToolCount: number;
  selectedToolCount: number;
}

export const TASK_ROUTING_WINDOW_STEPS = 2;

const FRESH_SESSION_ROUTING_RULES = [
  "Create a task only when the current user request has a concrete deliverable and enough detail to begin work now.",
  "Do not create a task for early conversation, brainstorming, vague intent, preferences, or discovery. Reply directly with one short clarifying question.",
  "A concrete deliverable means the user has specified what to make, change, analyze, or produce, and the expected output is clear enough to start without another user answer.",
  "For clear durable work with no active task, call git_context_create_task_for_turn with title, objective, and reason. If an active task exists, create a new task only for clearly separate work and include whyNotActiveTask plus separateTaskReason.",
  "Never print task metadata JSON as the assistant response. Put task metadata in the native tool call arguments.",
];

export function detectRuntimeCapabilityMode(input: {
  state: LoopState;
  workRunHandle?: MemoryRunHandle;
}): RuntimeCapabilityMode {
  const hasWorkRun = Boolean(input.state.runId || input.workRunHandle?.runId);
  const focusStatus = input.state.harnessContext.contextEngine?.focus.status;
  const pendingTurnStatus = input.state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const routingWindow = buildRuntimeRoutingWindow(input.state, hasWorkRun, pendingTurnStatus);
  const common = {
    primary: true as const,
    hasWorkRun,
    ...(focusStatus ? { focusStatus } : {}),
    ...(pendingTurnStatus ? { pendingTurnStatus } : {}),
    ...(routingWindow ? { routingWindow } : {}),
  };

  if (hasWorkRun) {
    return {
      ...common,
      name: "task_run",
      whyActive: "A task run exists for the current turn.",
      allowedActions: ["direct_reply", "decision_load_tools", "normal_work_tools"],
      blockedCapabilities: ["task_routing_after_routing_is_resolved"],
      next: "Continue the task work with selected tools, load missing tools if needed, or reply when complete.",
      allowToolLoading: true,
    };
  }

  if (focusStatus === "none") {
    return {
      ...common,
      name: "fresh_session_routing",
      whyActive: "No active task exists.",
      allowedActions: [
        "direct_reply",
        ...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES,
      ],
      blockedCapabilities: [
        "normal_work_tools",
        "decision_load_tools",
        "task_activation",
      ],
      next: "Create the first task for durable work, ask a short clarification, or reply directly for non-task chat.",
      rules: FRESH_SESSION_ROUTING_RULES,
      repairCode: "R_FRESH_SESSION_NEEDS_TASK",
      allowToolLoading: false,
    };
  }

  if (pendingTurnStatus === "unbound" || pendingTurnStatus === "clarifying") {
    return {
      ...common,
      name: "pre_task_routing",
      whyActive: `The current pending turn is ${pendingTurnStatus}.`,
      allowedActions: pendingTurnStatus === "clarifying"
        ? ["direct_reply"]
        : [
          "direct_reply",
          ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
          ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
        ],
      blockedCapabilities: ["normal_work_tools"],
      next: pendingTurnStatus === "clarifying"
        ? "Ask the user directly which task or target they mean."
        : "Route the turn to an existing task, create a new task, ask clarification, or reply directly for non-task chat.",
      repairCode: pendingTurnStatus === "clarifying" ? "R_PENDING_TURN_CLARIFYING" : "R_PENDING_TURN_UNBOUND",
      allowToolLoading: false,
    };
  }

  return {
    ...common,
    name: "session_only",
    whyActive: "No task run is active for this decision.",
    allowedActions: ["direct_reply", "decision_load_tools"],
    blockedCapabilities: ["normal_work_tools_until_task_run_exists"],
    next: "Reply directly for session-only conversation, or let task binding create a run before durable work.",
    allowToolLoading: true,
  };
}

export function buildRuntimeCapabilityPromptContext(mode: RuntimeCapabilityMode): RuntimeCapabilityPromptContext {
  return {
    name: mode.name,
    why: mode.whyActive,
    allowed: mode.allowedActions,
    blocked: mode.blockedCapabilities,
    next: mode.next,
    ...(mode.rules ? { rules: mode.rules } : {}),
    ...(mode.repairCode ? { repairCode: mode.repairCode } : {}),
    ...(mode.routingWindow ? { routingWindow: mode.routingWindow } : {}),
  };
}

export function isFreshSessionRoutingMode(mode: RuntimeCapabilityMode): boolean {
  return mode.name === "fresh_session_routing";
}

export function isRuntimeToolAllowed(mode: RuntimeCapabilityMode, toolName: string): boolean {
  if (mode.name === "task_run" || mode.pendingTurnStatus === "bound") {
    return !isGitContextTurnRoutingToolName(toolName);
  }
  if (mode.name === "fresh_session_routing") {
    return isGitContextFreshSessionRoutingToolName(toolName);
  }
  if (mode.name === "pre_task_routing") {
    return mode.pendingTurnStatus === "unbound" && isGitContextAllowedDuringPendingRouting(toolName);
  }
  return true;
}

export function filterToolsForRuntimeMode(mode: RuntimeCapabilityMode, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => isRuntimeToolAllowed(mode, tool.name));
}

export function requiredRoutingMutationToolsForRuntimeMode(mode: RuntimeCapabilityMode): string[] {
  if (mode.name === "fresh_session_routing") {
    return [...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES];
  }
  if (mode.name === "pre_task_routing" && mode.pendingTurnStatus === "unbound") {
    return [...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES];
  }
  return [];
}

export function deterministicToolsForRuntimeMode(mode: RuntimeCapabilityMode): string[] | undefined {
  if (mode.name === "fresh_session_routing") {
    return [...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES];
  }
  if (mode.name === "pre_task_routing") {
    return mode.pendingTurnStatus === "unbound"
      ? [
        ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
        ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
      ]
      : [];
  }
  return undefined;
}

export function isDecisionAllowedInRuntimeMode(mode: RuntimeCapabilityMode, decision: AgentDecision): boolean {
  if (mode.name !== "fresh_session_routing") {
    return true;
  }
  if (decision.kind === "reply") {
    return true;
  }
  if (decision.kind !== "act" || decision.action.calls.length === 0) {
    return false;
  }
  return decision.action.calls.every((call) => isGitContextAllowedInFreshSession(call.tool))
    && decision.action.allowedTools.every(isGitContextAllowedInFreshSession);
}

function isGitContextAllowedInFreshSession(tool: string): boolean {
  return isGitContextReadOnlyToolName(tool) || isGitContextFreshSessionRoutingToolName(tool);
}

export function summarizeRuntimeCapabilityTools(input: {
  mode: RuntimeCapabilityMode;
  visibleTools: ToolDefinition[];
  selectedTools: ToolDefinition[];
}): RuntimeCapabilityToolSummary {
  const visibleToolNames = input.visibleTools.map((tool) => tool.name);
  const selectedToolNames = input.selectedTools.map((tool) => tool.name);
  return {
    mode: input.mode.name,
    hasWorkRun: input.mode.hasWorkRun,
    ...(input.mode.focusStatus ? { focusStatus: input.mode.focusStatus } : {}),
    ...(input.mode.pendingTurnStatus ? { pendingTurnStatus: input.mode.pendingTurnStatus } : {}),
    visibleRoutingTools: visibleToolNames.filter(isGitContextRoutingToolName),
    selectedRoutingTools: selectedToolNames.filter(isGitContextRoutingToolName),
    visibleNormalTools: visibleToolNames.filter((tool) => !isGitContextRoutingToolName(tool)),
    selectedNormalTools: selectedToolNames.filter((tool) => !isGitContextRoutingToolName(tool)),
    visibleReadTools: visibleToolNames.filter(isGitContextReadOnlyToolName),
    selectedReadTools: selectedToolNames.filter(isGitContextReadOnlyToolName),
    visibleTaskRoutingTools: visibleToolNames.filter(isGitContextTurnRoutingToolName),
    selectedTaskRoutingTools: selectedToolNames.filter(isGitContextTurnRoutingToolName),
    visibleToolCount: visibleToolNames.length,
    selectedToolCount: selectedToolNames.length,
  };
}

export function isGitContextRoutingToolName(tool: string): boolean {
  return isGitContextAllowedDuringPendingRouting(tool);
}

function buildRuntimeRoutingWindow(
  state: LoopState,
  hasWorkRun: boolean,
  pendingTurnStatus: string | undefined,
): RuntimeCapabilityRoutingWindow | undefined {
  if (hasWorkRun || pendingTurnStatus === "clarifying") {
    return undefined;
  }
  const step = Math.max(1, state.iteration || 1);
  const routingResolved = state.completedSteps.some((completedStep) => {
    return (completedStep.toolsUsed ?? []).some(isGitContextTurnRoutingToolName);
  });
  const open = !routingResolved && step <= TASK_ROUTING_WINDOW_STEPS;
  const remaining = open ? Math.max(0, TASK_ROUTING_WINDOW_STEPS - step) : 0;
  return {
    open,
    ...(!open ? { expired: true } : {}),
    step,
    maxSteps: TASK_ROUTING_WINDOW_STEPS,
    remaining,
    expiresAfterThisDecision: open && remaining === 0,
    readToolsAvailable: true,
    routingToolsAvailable: open,
    readToolsRemainAfterExpiry: true,
    guidance: open
      ? remaining === 0
        ? "Routing expires after this decision. Use create, switch, or clarification now if this turn is not the active task; otherwise continue the active task."
        : "Use create, switch, or clarification if this turn belongs to a different or new task; otherwise continue the active task."
      : "Task routing tools are expired for this pre-run decision. Read-only git-context tools can still inspect context; action tools continue the active task when one is active.",
  };
}
