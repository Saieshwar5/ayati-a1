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
  isGitContextReadOnlyToolName,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type { LoopState } from "../types.js";
import type { AgentDecision } from "./decision.js";
import type { RepairCode } from "./repair-policy.js";
import { isClearlyConversationOnlyRequest } from "./turn-intent-policy.js";

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
  hasDeferredMutation: boolean;
  focusStatus?: string;
  pendingTurnStatus?: string;
  whyActive: string;
  allowedActions: string[];
  blockedCapabilities: string[];
  next: string;
  rules?: string[];
  repairCode?: RepairCode;
  allowToolLoading: boolean;
  routingSuppressedForConversation?: boolean;
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
  hasDeferredMutation: boolean;
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

const FRESH_SESSION_ROUTING_RULES = [
  "Create a task only when the current user request has a concrete deliverable and enough detail to begin work now.",
  "Do not create a task for early conversation, brainstorming, vague intent, preferences, or discovery. Reply directly with one short clarifying question.",
  "A concrete deliverable means the user has specified what to make, change, analyze, or produce, and the expected output is clear enough to start without another user answer.",
  "For clear durable work, inspect the task candidates already present in context. Activate the exact matching task with an explicit continue-or-create request decision, or create one managed V1 task with title, objective, and reason when the durable workstream is distinct.",
  "Never print task metadata JSON as the assistant response. Put task metadata in the native tool call arguments.",
];

export function detectRuntimeCapabilityMode(input: {
  state: LoopState;
  workRunHandle?: MemoryRunHandle;
  sessionRunHandle?: MemoryRunHandle;
}): RuntimeCapabilityMode {
  const hasWorkRun = Boolean(input.state.runId || input.workRunHandle?.runId);
  const hasSessionRun = Boolean(input.sessionRunHandle?.runId);
  const hasDeferredMutation = Boolean(input.state.deferredMutation);
  const routingSuppressedForConversation = input.state.inputKind === "user_message"
    && !hasDeferredMutation
    && isClearlyConversationOnlyRequest(input.state.userMessage);
  const focusStatus = input.state.harnessContext.contextEngine?.focus.status;
  const pendingTurnStatus = input.state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  const routingWindow = buildRuntimeRoutingWindow(
    input.state,
    hasWorkRun,
    pendingTurnStatus,
    routingSuppressedForConversation,
  );
  const common = {
    primary: true as const,
    hasWorkRun,
    hasSessionRun,
    hasDeferredMutation,
    ...(focusStatus ? { focusStatus } : {}),
    ...(pendingTurnStatus ? { pendingTurnStatus } : {}),
    ...(routingWindow ? { routingWindow } : {}),
    ...(routingSuppressedForConversation ? { routingSuppressedForConversation: true } : {}),
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
    const freshRoutingActions = routingSuppressedForConversation
      ? []
      : [...GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES];
    const freshBlockedCapabilities = [
      "workspace_mutation_until_task_promotion",
      "external_mutation_until_task_promotion",
      "task_activation",
      ...(routingSuppressedForConversation ? ["task_routing_for_conversation_only_turn"] : []),
    ];
    if (hasSessionRun) {
      return {
        ...common,
        name: "fresh_session_routing",
        whyActive: "A session run exists and no active task exists.",
        allowedActions: [
          "direct_reply",
          "decision_load_tools",
          "read_only_tools",
          ...freshRoutingActions,
        ],
        blockedCapabilities: [
          ...freshBlockedCapabilities,
          "destructive_tools_until_task_promotion",
        ],
        next: routingSuppressedForConversation
          ? "Answer directly or use read-only tools; this turn has no durable task-routing intent."
          : "Use read-only tools for inspection. Before durable mutation, search/activate an existing task or create a new task; ask a short clarification directly if ownership is unclear.",
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
        "decision_load_tools",
        "read_only_tools",
        ...freshRoutingActions,
      ],
      blockedCapabilities: freshBlockedCapabilities,
      next: routingSuppressedForConversation
        ? "Answer directly or use read-only tools; this turn has no durable task-routing intent."
        : "Use read-only tools for inspection. Before durable mutation, create or activate a task, ask a short clarification directly, or reply directly for non-task chat.",
      rules: FRESH_SESSION_ROUTING_RULES,
      repairCode: "R_FRESH_SESSION_NEEDS_TASK",
      allowToolLoading: true,
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
    if (hasDeferredMutation) {
      return {
        ...common,
        name: "active_task_ready",
        whyActive: "A mutation is paused until this session run is bound to a task.",
        allowedActions: [
          "direct_reply",
          ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
          ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
        ],
        blockedCapabilities: [
          "decision_load_tools",
          "normal_work_tools_until_task_binding",
        ],
        next: "Bind the turn to the active task, switch to another task, create a new task, or ask one short clarification if ownership is ambiguous. The deferred mutation will replay after binding.",
        repairCode: "R_PENDING_TURN_UNBOUND",
        allowToolLoading: false,
      };
    }
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
      next: "Use normal work tools to continue the active task. Use routing tools before task-run creation only when the turn belongs to a new or different task.",
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
    if (mode.hasDeferredMutation) {
      return isGitContextAllowedDuringPendingRouting(toolName);
    }
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
    if (isTaskRoutingMutation(taxonomy)) {
      return Boolean(mode.routingWindow?.open) && taxonomy.canRunBeforeTask;
    }
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
  if (!mode.routingSuppressedForConversation
    && (mode.name === "fresh_session_routing" || mode.name === "pre_task_routing" || mode.routingWindow?.open)) {
    return "routing";
  }
  return selectedToolCount > 0 ? "enquiry" : "conversation";
}

export function requiredRoutingMutationToolsForRuntimeMode(mode: RuntimeCapabilityMode): string[] {
  if (mode.routingSuppressedForConversation || mode.routingWindow?.routingToolsAvailable === false) {
    return [];
  }
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
    return undefined;
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
  if (mode.allowToolLoading && decision.kind === "load_tools") {
    return true;
  }
  if (decision.kind !== "act" || decision.action.calls.length === 0) {
    return false;
  }
  return decision.action.calls.every((call) => isRuntimeToolAllowed(mode, call.tool))
    && decision.action.allowedTools.every((tool) => isRuntimeToolAllowed(mode, tool));
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
    hasDeferredMutation: input.mode.hasDeferredMutation,
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
  routingSuppressedForConversation: boolean,
): RuntimeCapabilityRoutingWindow | undefined {
  if (hasWorkRun || pendingTurnStatus === "clarifying") {
    return undefined;
  }
  const routingResolved = state.completedSteps.some((completedStep) => {
    return completedStep.outcome !== "failed"
      && (completedStep.toolsUsed ?? []).some(isGitContextTurnRoutingToolName);
  });
  const routingAttempts = state.routingAttempts ?? {
    successCount: 0,
    failureCount: 0,
    maxFailures: 2,
    resolved: false,
  };
  const resolved = routingResolved || routingAttempts.resolved || routingAttempts.successCount > 0;
  const retryLimitReached = routingAttempts.failureCount >= routingAttempts.maxFailures;
  const open = !routingSuppressedForConversation && !resolved && !retryLimitReached;
  const step = Math.max(1, state.iteration || 1);
  return {
    open,
    ...(!open ? { expired: true } : {}),
    step,
    maxSteps: 0,
    remaining: 0,
    expiresAfterThisDecision: false,
    readToolsAvailable: true,
    routingToolsAvailable: open,
    readToolsRemainAfterExpiry: true,
    guidance: routingSuppressedForConversation
      ? "Task-routing mutation tools are hidden for this clearly conversational request; answer directly or use read-only tools."
      : retryLimitReached
      ? "Task routing retry limit was reached for this turn. Ask the user a short clarification or explain the blocker; do not call create or activate again."
      : state.deferredMutation
      ? "A mutation is deferred until task ownership is resolved. Use activate, search/activate, or create now; the deferred mutation will execute automatically after routing."
      : open
      ? "Routing tools remain available while this turn is still a session run. Use create, switch, or clarification if this turn belongs to a different or new task; otherwise continue the active task."
      : "Task routing is resolved for this turn.",
  };
}
