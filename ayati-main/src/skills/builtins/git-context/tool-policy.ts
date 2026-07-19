export const GIT_CONTEXT_READ_ONLY_TOOL_NAMES = [
  "git_context_find_tasks",
  "git_context_read_task",
] as const;

export const GIT_CONTEXT_PREFERENCE_TOOL_NAMES = [
  "git_context_set_task_star",
] as const;

export const GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES = [
  "git_context_inspect_task_location",
] as const;

export const GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES = [
  "git_context_activate_task",
  "git_context_create_task",
] as const;

export const GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES = [
  "git_context_activate_task",
  "git_context_create_task",
] as const;

const READ_ONLY_TOOL_NAMES = new Set<string>(GIT_CONTEXT_READ_ONLY_TOOL_NAMES);
const PREFERENCE_TOOL_NAMES = new Set<string>(GIT_CONTEXT_PREFERENCE_TOOL_NAMES);
const ROUTING_SUPPORT_TOOL_NAMES = new Set<string>(GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES);
const TURN_ROUTING_TOOL_NAMES = new Set<string>(GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES);
const UNBOUND_RUN_ROUTING_TOOL_NAMES = new Set<string>(GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES);

export function isGitContextReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isGitContextTurnRoutingToolName(name: string): boolean {
  return TURN_ROUTING_TOOL_NAMES.has(name);
}

export function isGitContextUnboundRunRoutingToolName(name: string): boolean {
  return UNBOUND_RUN_ROUTING_TOOL_NAMES.has(name);
}

export function isGitContextPreferenceToolName(name: string): boolean {
  return PREFERENCE_TOOL_NAMES.has(name);
}

export function isGitContextRoutingSupportToolName(name: string): boolean {
  return ROUTING_SUPPORT_TOOL_NAMES.has(name);
}

export function isGitContextAllowedDuringPendingRouting(name: string): boolean {
  return isGitContextReadOnlyToolName(name)
    || isGitContextPreferenceToolName(name)
    || isGitContextRoutingSupportToolName(name)
    || isGitContextTurnRoutingToolName(name);
}
