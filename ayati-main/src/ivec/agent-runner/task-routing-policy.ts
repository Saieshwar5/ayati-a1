import { isAbsolute, normalize, resolve } from "node:path";
import type { MemoryRunHandle } from "../../memory/types.js";
import type {
  ActOutput,
  ActToolCallRecord,
  LoopState,
  RoutingAttemptState,
  StepSummary,
} from "../types.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import { isReadOnlyTool } from "../../skills/tool-taxonomy.js";
import {
  isGitContextAllowedDuringPendingRouting,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";

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

export function validateRoutingAttemptLimits(
  state: LoopState,
  action: AgentAction,
  hasWorkRun: boolean,
): RoutingAttemptBlock | undefined {
  const tools = routingMutationToolsForAction(action);
  if (tools.length === 0) {
    return undefined;
  }
  if (hasWorkRun) {
    return {
      reason: "task_run_already_exists",
      message: "Task routing tools cannot run after this turn is already bound to a task run.",
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

export function routingMutationToolsForAction(action: AgentAction): string[] {
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

export function shouldDeferPreTaskMutation(
  state: LoopState,
  decision: AgentDecision,
  workRunHandle: MemoryRunHandle | undefined,
): boolean {
  if (workRunHandle || decision.kind !== "act") {
    return false;
  }
  if (state.harnessContext.contextEngine?.focus.status === "active" && !state.deferredMutation) {
    return false;
  }
  if (decision.action.calls.some((call) => isGitContextTurnRoutingToolName(call.tool))) {
    return false;
  }
  return decision.action.calls.some((call) => isPreTaskMutationTool(call.tool));
}

export function isPreTaskMutationTool(tool: string): boolean {
  return !isReadOnlyTool(tool) && !isGitContextAllowedDuringPendingRouting(tool);
}

export function deferredMutationToolNames(action: AgentAction): string[] {
  return uniqueStrings(action.calls
    .map((call) => call.tool)
    .filter(isPreTaskMutationTool));
}

export function shouldAutoBindActiveTaskArtifactMutation(
  state: LoopState,
  decision: AgentDecision,
): boolean {
  if (state.runId || decision.kind !== "act") {
    return false;
  }
  const contextEngine = state.harnessContext.contextEngine;
  if (!contextEngine || contextEngine.focus.status !== "active" || !contextEngine.task) {
    return false;
  }
  if (!decision.action.calls.some((call) => isPreTaskMutationTool(call.tool))) {
    return false;
  }
  const mutationTargets = mutationTargetPathsForAction(decision.action);
  if (mutationTargets.length === 0) {
    return false;
  }
  const ownedTargets = activeTaskOwnedTargets(state);
  if (ownedTargets.paths.size === 0 && ownedTargets.names.size === 0 && ownedTargets.directories.size === 0) {
    return false;
  }
  return mutationTargets.every((target) => isOwnedByActiveTask(target, ownedTargets));
}

export function mutationTargetPathsForAction(action: AgentAction): string[] {
  return uniqueStrings(action.calls.flatMap((call) => mutationTargetPathsForCall(call.tool, call.input)));
}

export function stepUsesFileMutationTool(step: StepSummary): boolean {
  return (step.toolsUsed ?? []).some((tool) => FILE_MUTATION_TOOL_NAMES.has(tool));
}

function mutationTargetPathsForCall(tool: string, input: Record<string, unknown>): string[] {
  if (!isPreTaskMutationTool(tool)) {
    return [];
  }
  const direct = [
    readInputString(input, "path"),
    readInputString(input, "from"),
    readInputString(input, "to"),
    readInputString(input, "source"),
    readInputString(input, "destination"),
    readInputString(input, "target"),
  ];
  const files = readInputArrayPaths(input, "files");
  const edits = readInputArrayPaths(input, "edits");
  return uniqueStrings([...direct, ...files, ...edits].filter((path): path is string => Boolean(path)));
}

function readInputString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readInputArrayPaths(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return [
      readInputString(record, "path"),
      readInputString(record, "from"),
      readInputString(record, "to"),
    ].filter((path): path is string => Boolean(path));
  });
}

interface ActiveTaskOwnedTargets {
  paths: Set<string>;
  names: Set<string>;
  directories: Set<string>;
}

function activeTaskOwnedTargets(state: LoopState): ActiveTaskOwnedTargets {
  const task = state.harnessContext.contextEngine?.task;
  const paths = new Set<string>();
  const names = new Set<string>();
  const directories = new Set<string>();
  const addPath = (value: string | undefined, kind?: string): void => {
    if (!value || value.trim().length === 0) {
      return;
    }
    const raw = value.trim();
    paths.add(normalizePathKey(raw));
    const workspacePath = workspaceRelativePath(raw);
    if (workspacePath) {
      paths.add(normalizePathKey(workspacePath));
    }
    const name = raw.split(/[\\/]/).filter(Boolean).at(-1);
    if (name) {
      names.add(name);
    }
    if (kind === "directory") {
      directories.add(normalizePathKey(raw));
      if (workspacePath) {
        directories.add(normalizePathKey(workspacePath));
      }
    }
  };

  for (const asset of task?.assets ?? []) {
    addPath(asset.path, asset.kind);
    if (asset.name) {
      names.add(asset.name);
    }
  }
  for (const artifact of task?.artifacts ?? []) {
    addPath(artifact.path);
  }
  for (const run of task?.recentRuns ?? []) {
    for (const changedFile of run.changedFilesPreview ?? []) {
      addPath(changedFile);
    }
  }
  for (const evidence of task?.recentEvidence ?? []) {
    for (const artifact of evidence.artifacts ?? []) {
      addPath(artifact);
    }
  }
  return { paths, names, directories };
}

function isOwnedByActiveTask(target: string, owned: ActiveTaskOwnedTargets): boolean {
  const raw = target.trim();
  if (!raw) {
    return false;
  }
  const candidates = uniqueStrings([
    normalizePathKey(raw),
    workspaceRelativePath(raw),
  ].filter((path): path is string => Boolean(path)).map(normalizePathKey));
  if (candidates.some((candidate) => owned.paths.has(candidate))) {
    return true;
  }
  const name = raw.split(/[\\/]/).filter(Boolean).at(-1);
  if (name && name === raw && owned.names.has(name)) {
    return true;
  }
  return candidates.some((candidate) => {
    for (const directory of owned.directories) {
      if (candidate === directory || candidate.startsWith(`${directory}/`)) {
        return true;
      }
    }
    return false;
  });
}

function workspaceRelativePath(path: string): string | undefined {
  if (isAbsolute(path)) {
    return path;
  }
  const workspaceDir = process.env["AYATI_WORKSPACE_DIR"]?.trim();
  if (!workspaceDir) {
    return undefined;
  }
  return resolve(workspaceDir, path);
}

function normalizePathKey(path: string): string {
  return normalize(path.trim()).replace(/\\/g, "/");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
