import type { MemoryRunHandle } from "../../memory/types.js";
import type { ToolDefinition } from "../../skills/types.js";
import {
  getToolTaxonomy,
  isToolAllowedInPhase,
  type ToolPhase,
  type ToolTaxonomyEntry,
} from "../../skills/tool-taxonomy.js";
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
  | "active_task_ready"
  | "fresh_session_routing"
  | "pre_task_routing"
  | "session_only";

export interface RuntimeCapabilityMode {
  name: RuntimeCapabilityModeName;
  primary: true;
  hasWorkRun: boolean;
  hasSessionRun: boolean;
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
  hasSessionRun: boolean;
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
  "For clear durable work with no active task, call git_context_create_task_for_turn with title, objective, and createReason \"no_active_task\" before mutation. If existing task ownership is possible, use git_context_search_tasks and git_context_activate_task_for_turn instead.",
  "Never print task metadata JSON as the assistant response. Put task metadata in the native tool call arguments.",
];

export function detectRuntimeCapabilityMode(input: {
  state: LoopState;
  workRunHandle?: MemoryRunHandle;
  sessionRunHandle?: MemoryRunHandle;
}): RuntimeCapabilityMode {
  const hasWorkRun = Boolean(input.state.runId || input.workRunHandle?.runId);
  const hasSessionRun = Boolean(input.sessionRunHandle?.runId);
  const focusStatus = input.state.harnessContext.contextEngine?.focus.status;
  const pendingTurnStatus = input.state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const routingWindow = buildRuntimeRoutingWindow(input.state, hasWorkRun, pendingTurnStatus);
  const common = {
    primary: true as const,
    hasWorkRun,
    hasSessionRun,
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
    if (hasSessionRun) {
      return {
        ...common,
        name: "fresh_session_routing",
        whyActive: "A session run exists and no active task exists.",
        allowedActions: [
          "direct_reply",
          "decision_load_tools",
          "read_only_tools",
          ...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES,
        ],
        blockedCapabilities: [
          "workspace_mutation_until_task_promotion",
          "external_mutation_until_task_promotion",
          "destructive_tools_until_task_promotion",
          "task_activation",
        ],
        next: "Use read-only tools for inspection. Before durable mutation, search/activate an existing task or create a new task; ask a short clarification directly if ownership is unclear.",
        rules: FRESH_SESSION_ROUTING_RULES,
        repairCode: "R_FRESH_SESSION_NEEDS_TASK",
        allowToolLoading: true,
      };
    }
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
      next: "Create or activate a task for durable work, ask a short clarification directly, or reply directly for non-task chat.",
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

  if (focusStatus === "active") {
    return {
      ...common,
      name: "active_task_ready",
      whyActive: "An active task exists and a task run can be created automatically before normal work tools execute.",
      allowedActions: [
        "direct_reply",
        "decision_load_tools",
        "normal_work_tools",
        ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
        ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
      ],
      blockedCapabilities: [],
      next: "Use normal work tools to continue the active task, or use routing tools within the short routing window only when the turn belongs to a new or different task.",
      allowToolLoading: true,
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
  const taxonomy = getToolTaxonomy(toolName);
  if (!taxonomy) {
    if (
      mode.hasSessionRun
      && mode.pendingTurnStatus !== "clarifying"
      && (mode.name === "fresh_session_routing" || mode.name === "pre_task_routing")
    ) {
      return true;
    }
    return mode.name === "task_run" || mode.name === "active_task_ready" || mode.hasWorkRun;
  }

  if (mode.name === "task_run" || mode.hasWorkRun) {
    return !isTaskRoutingMutation(taxonomy);
  }

  if (mode.name === "active_task_ready") {
    if (isTaskRoutingMutation(taxonomy)) {
      return Boolean(mode.routingWindow?.open) && taxonomy.canRunBeforeTask;
    }
    return true;
  }

  if (mode.pendingTurnStatus === "clarifying") {
    return false;
  }

  if (
    mode.hasSessionRun
    && (mode.name === "fresh_session_routing" || mode.name === "pre_task_routing")
  ) {
    return true;
  }

  if (isReadOnlyAllowedBeforeTask(mode, toolName, taxonomy)) {
    return true;
  }

  if (isTaskRoutingMutation(taxonomy)) {
    return Boolean(mode.routingWindow?.open) && taxonomy.canRunBeforeTask;
  }

  return false;
}

export function filterToolsForRuntimeMode(mode: RuntimeCapabilityMode, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => isRuntimeToolAllowed(mode, tool.name));
}

export function runtimeToolPhase(mode: RuntimeCapabilityMode, selectedToolCount = 0): ToolPhase {
  if (mode.name === "task_run" || mode.name === "active_task_ready" || mode.hasWorkRun) {
    return "task_run";
  }
  if (mode.name === "fresh_session_routing" || mode.name === "pre_task_routing" || mode.routingWindow?.open) {
    return "routing";
  }
  return selectedToolCount > 0 ? "enquiry" : "conversation";
}

export function requiredRoutingMutationToolsForRuntimeMode(mode: RuntimeCapabilityMode): string[] {
  if (mode.name === "fresh_session_routing") {
    return [...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES];
  }
  if (mode.name === "pre_task_routing" && mode.pendingTurnStatus === "unbound") {
    return [...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES];
  }
  if (!mode.hasWorkRun && mode.routingWindow?.open) {
    return [...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES];
  }
  return [];
}

export function deterministicToolsForRuntimeMode(mode: RuntimeCapabilityMode): string[] | undefined {
  if (mode.hasSessionRun && mode.pendingTurnStatus !== "clarifying") {
    return undefined;
  }
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
  if (mode.hasSessionRun && decision.kind === "load_tools") {
    return true;
  }
  if (decision.kind !== "act" || decision.action.calls.length === 0) {
    return false;
  }
  if (mode.hasSessionRun) {
    return decision.action.calls.every((call) => isRuntimeToolAllowed(mode, call.tool))
      && decision.action.allowedTools.every((tool) => isRuntimeToolAllowed(mode, tool));
  }
  return decision.action.calls.every((call) => isGitContextAllowedInFreshSession(call.tool))
    && decision.action.allowedTools.every(isGitContextAllowedInFreshSession);
}

function isGitContextAllowedInFreshSession(tool: string): boolean {
  return isGitContextReadOnlyToolName(tool) || isGitContextFreshSessionRoutingToolName(tool);
}

function isReadOnlyAllowedBeforeTask(
  mode: RuntimeCapabilityMode,
  toolName: string,
  taxonomy: ToolTaxonomyEntry,
): boolean {
  if (taxonomy.effect !== "read_only") {
    return false;
  }
  if (mode.hasSessionRun) {
    return taxonomy.allowedPhases.some((phase) => phase === "conversation" || phase === "enquiry" || phase === "routing");
  }
  if (isToolAllowedInPhase(toolName, runtimeToolPhase(mode, 1))) {
    return true;
  }
  return Boolean(mode.routingWindow?.open) && isToolAllowedInPhase(toolName, "enquiry");
}

function isTaskRoutingMutation(taxonomy: ToolTaxonomyEntry): boolean {
  return taxonomy.effect === "context_mutation" && taxonomy.roles.includes("task_routing");
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
    hasSessionRun: input.mode.hasSessionRun,
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
    return completedStep.outcome !== "failed"
      && (completedStep.toolsUsed ?? []).some(isGitContextTurnRoutingToolName);
  });
  const open = !routingResolved && (Boolean(state.deferredMutation) || step <= TASK_ROUTING_WINDOW_STEPS);
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
    guidance: state.deferredMutation
      ? "A mutation is deferred until task ownership is resolved. Use activate, search/activate, or create now; the deferred mutation will execute automatically after routing."
      : open
      ? remaining === 0
        ? "Routing expires after this decision. Use create, switch, or clarification now if this turn is not the active task; otherwise continue the active task."
        : "Use create, switch, or clarification if this turn belongs to a different or new task; otherwise continue the active task."
      : "Task routing tools are expired for this pre-run decision. Read-only git-context tools can still inspect context; action tools continue the active task when one is active.",
  };
}
