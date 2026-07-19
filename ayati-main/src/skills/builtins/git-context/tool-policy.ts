export const GIT_CONTEXT_READ_ONLY_TOOL_NAMES = [
  "git_context_find_workstreams",
  "git_context_read_workstream",
  "git_context_find_resources",
] as const;

export const GIT_CONTEXT_PREFERENCE_TOOL_NAMES = [
  "git_context_set_workstream_star",
] as const;

export const GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES = [
  "git_context_inspect_resource",
] as const;

export const GIT_CONTEXT_BOUND_RESOURCE_TOOL_NAMES = [
  "git_context_bind_resources",
] as const;

export const GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES = [
  "git_context_activate_workstream",
  "git_context_create_workstream",
] as const;

export const GIT_CONTEXT_UNBOUND_RUN_ROUTING_TOOL_NAMES = [
  "git_context_inspect_resource",
  "git_context_activate_workstream",
  "git_context_create_workstream",
] as const;

const READ_ONLY_TOOL_NAMES = new Set<string>(GIT_CONTEXT_READ_ONLY_TOOL_NAMES);
const PREFERENCE_TOOL_NAMES = new Set<string>(GIT_CONTEXT_PREFERENCE_TOOL_NAMES);
const ROUTING_SUPPORT_TOOL_NAMES = new Set<string>(GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES);
const BOUND_RESOURCE_TOOL_NAMES = new Set<string>(GIT_CONTEXT_BOUND_RESOURCE_TOOL_NAMES);
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

export function isGitContextBoundResourceToolName(name: string): boolean {
  return BOUND_RESOURCE_TOOL_NAMES.has(name);
}

export function isGitContextAllowedDuringPendingRouting(name: string): boolean {
  return isGitContextReadOnlyToolName(name)
    || isGitContextPreferenceToolName(name)
    || isGitContextRoutingSupportToolName(name)
    || isGitContextTurnRoutingToolName(name);
}
