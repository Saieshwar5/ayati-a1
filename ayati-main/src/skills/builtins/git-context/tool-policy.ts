export const GIT_CONTEXT_READ_ONLY_TOOL_NAMES = [
  "git_context_list_sessions",
  "git_context_active",
  "git_context_list_tasks",
  "git_context_search_tasks",
  "git_context_read_task",
  "git_context_read_evidence",
  "git_context_search_evidence",
  "git_context_log",
] as const;

export const GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES = [
  "git_context_activate_task_for_turn",
  "git_context_create_task_for_turn",
  "git_context_ask_clarification_for_turn",
] as const;

const READ_ONLY_TOOL_NAMES = new Set<string>(GIT_CONTEXT_READ_ONLY_TOOL_NAMES);
const TURN_ROUTING_TOOL_NAMES = new Set<string>(GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES);

export function isGitContextReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isGitContextTurnRoutingToolName(name: string): boolean {
  return TURN_ROUTING_TOOL_NAMES.has(name);
}

export function isGitContextAllowedDuringPendingRouting(name: string): boolean {
  return isGitContextReadOnlyToolName(name) || isGitContextTurnRoutingToolName(name);
}
