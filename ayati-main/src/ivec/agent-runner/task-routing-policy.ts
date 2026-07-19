import type {
  ActOutput,
  ActToolCallRecord,
  LoopState,
  RoutingAttemptState,
  StepSummary,
} from "../types.js";
import type { AgentAction } from "./decision.js";
import { isGitContextTurnRoutingToolName } from "../../skills/builtins/git-context/tool-policy.js";

const MAX_ROUTING_FAILURES_PER_TURN = 2;
const FILE_MUTATION_TOOL_NAMES = new Set([
  "patch_files",
  "write_files",
  "delete",
  "move",
  "create_directory",
]);

export interface RoutingAttemptBlock {
  reason: string;
  message: string;
  tools: string[];
}

export function createRoutingAttemptState(): RoutingAttemptState {
  return {
    successCount: 0,
    failureCount: 0,
    maxFailures: MAX_ROUTING_FAILURES_PER_TURN,
    resolved: false,
  };
}

export function hasExhaustedRoutingFailures(state: LoopState): boolean {
  return !state.routingAttempts.resolved
    && state.routingAttempts.successCount === 0
    && state.routingAttempts.failureCount >= state.routingAttempts.maxFailures;
}

export function validateRoutingAttemptLimits(
  state: LoopState,
  action: AgentAction,
  hasTaskBinding: boolean,
): RoutingAttemptBlock | undefined {
  const tools = routingControlToolsForAction(action);
  if (tools.length === 0) {
    return undefined;
  }
  if (hasTaskBinding) {
    return {
      reason: "task_binding_already_exists",
      message: "Task routing tools cannot run after this run is already bound to a task.",
      tools,
    };
  }
  if (tools.length > 1) {
    return {
      reason: "multiple_routing_tools",
      message: "Use exactly one task routing tool per routing decision.",
      tools,
    };
  }
  if (state.routingAttempts.resolved || state.routingAttempts.successCount > 0) {
    return {
      reason: "routing_already_resolved",
      message: "Task routing is already resolved for this turn; do not call create or activate again.",
      tools,
    };
  }
  if (state.routingAttempts.failureCount >= state.routingAttempts.maxFailures) {
    return {
      reason: "routing_retry_limit_reached",
      message: `Task routing retry limit reached for this turn after ${state.routingAttempts.failureCount} failed attempt(s). Ask the user a short clarification or explain the blocker instead of calling create or activate again.`,
      tools,
    };
  }
  return undefined;
}

export function routingControlToolsForAction(action: AgentAction): string[] {
  return uniqueStrings(action.calls
    .map((call) => call.tool)
    .filter(isGitContextTurnRoutingToolName));
}

export function updateRoutingAttemptsFromActOutput(
  state: LoopState,
  actOutput: ActOutput,
  options: {
    blocked: boolean;
  },
): void {
  if (options.blocked) {
    return;
  }
  for (const call of actOutput.toolCalls.filter((item) => isGitContextTurnRoutingToolName(item.tool))) {
    state.routingAttempts.lastTool = call.tool;
    const routingStatus = readRoutingToolStatus(call);
    if (!call.error && routingStatus === "ready") {
      state.routingAttempts.successCount += 1;
      state.routingAttempts.resolved = true;
      state.routingAttempts.lastError = undefined;
      continue;
    }
    if (call.error) {
      state.routingAttempts.failureCount += 1;
      state.routingAttempts.lastError = call.error;
    }
  }
}

export function readRoutingToolStatus(call: ActToolCallRecord): string | undefined {
  const content = call.result?.structuredContent;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return undefined;
  }
  const status = (content as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : undefined;
}

export function summarizeRoutingAttempts(routing: RoutingAttemptState): Record<string, unknown> {
  return {
    successCount: routing.successCount,
    failureCount: routing.failureCount,
    maxFailures: routing.maxFailures,
    resolved: routing.resolved,
    ...(routing.lastTool ? { lastTool: routing.lastTool } : {}),
    ...(routing.lastError ? { lastError: routing.lastError } : {}),
  };
}

export function stepUsesFileMutationTool(step: StepSummary): boolean {
  return (step.toolsUsed ?? []).some((tool) => FILE_MUTATION_TOOL_NAMES.has(tool));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
