export const GIT_CONTEXT_READ_ONLY_TOOL_NAMES = [] as const;

export const GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES = [
  "git_context_activate_task",
  "git_context_create_task",
] as const;

export const GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES = [
  "git_context_activate_task",
  "git_context_create_task",
] as const;

const READ_ONLY_TOOL_NAMES = new Set<string>(GIT_CONTEXT_READ_ONLY_TOOL_NAMES);
const TURN_ROUTING_TOOL_NAMES = new Set<string>(GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES);
const FRESH_SESSION_ROUTING_TOOL_NAMES = new Set<string>(GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES);

export function isGitContextReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}

export function isGitContextTurnRoutingToolName(name: string): boolean {
  return TURN_ROUTING_TOOL_NAMES.has(name);
}

export function isGitContextFreshSessionRoutingToolName(name: string): boolean {
  return FRESH_SESSION_ROUTING_TOOL_NAMES.has(name);
}

export function isGitContextAllowedDuringPendingRouting(name: string): boolean {
  return isGitContextReadOnlyToolName(name) || isGitContextTurnRoutingToolName(name);
}
