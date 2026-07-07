import type { ToolExecutionContext, ToolDefinition } from "../../skills/types.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import type { ActToolCallRecord, LoopState } from "../types.js";
import type { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.js";
import {
  GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES,
  GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import { getToolLoadPriority } from "../../skills/tool-taxonomy.js";
import {
  detectRuntimeCapabilityMode,
  deterministicToolsForRuntimeMode,
  isFreshSessionRoutingMode,
  isRuntimeToolAllowed,
  requiredRoutingMutationToolsForRuntimeMode,
  TASK_ROUTING_WINDOW_STEPS,
} from "./runtime-capability-mode.js";
import {
  hasRecoverableCompactedRunToolCall,
  RUN_STEP_RECOVERY_TOOL_NAME,
} from "./run-tool-call-context.js";

export interface ToolLoadRequest {
  query?: string;
  toolNames?: string[];
  groups?: string[];
}

export type ToolLoadStatus = "loaded" | "partial" | "already_active" | "no_match" | "invalid_request" | "failed" | "not_needed";

export interface ToolWorkingSetManagerOptions {
  catalog: ToolCatalog;
  toolExecutor: ToolExecutor;
  maxVisibleTools?: number;
}

export interface ToolLoadResult {
  status: ToolLoadStatus;
  requested: {
    query?: string;
    toolNames: string[];
    groups: string[];
  };
  loaded: string[];
  alreadyActive: string[];
  evicted: string[];
  missing: string[];
  message: string;
}

interface RunToolState {
  ordered: string[];
  loadedAtStep: Map<string, number>;
  usedAtStep: Map<string, number>;
  taskRouting: {
    resolved: boolean;
  };
}

const DEFAULT_MAX_VISIBLE_TOOLS = 15;
const TASK_ROUTING_WINDOW_TOOL_NAMES = [
  "git_context_active",
  "git_context_list_tasks",
  "git_context_search_tasks",
  "git_context_read_task",
  ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
] as const;

export class ToolWorkingSetManager {
  private readonly catalog: ToolCatalog;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxVisibleTools: number;
  private readonly runs = new Map<string, RunToolState>();

  constructor(options: ToolWorkingSetManagerOptions) {
    this.catalog = options.catalog;
    this.toolExecutor = options.toolExecutor;
    this.maxVisibleTools = options.maxVisibleTools ?? DEFAULT_MAX_VISIBLE_TOOLS;
  }

  getPromptSummary(): string {
    return this.catalog.promptSummary();
  }

  visibleToolDefinitions(context: ToolExecutionContext): ToolDefinition[] {
    return this.toolExecutor.definitions(context);
  }

  listActive(context: ToolExecutionContext): string[] {
    return [...this.getRunState(context).ordered];
  }

  resetRun(context: ToolExecutionContext): void {
    const runId = readRunId(context);
    this.runs.delete(runId);
    this.toolExecutor.unmount?.(this.groupId(runId));
  }

  prepareForDecision(state: LoopState, context: ToolExecutionContext): ToolLoadResult {
    const runState = this.getRunState(context);
    const step = context.stepNumber ?? 0;
    const mode = detectRuntimeCapabilityMode({ state });
    if (mode.hasWorkRun || mode.pendingTurnStatus === "bound") {
      this.removeTaskRoutingResolutionTools(runState, []);
      this.syncMount(context);
    }
    if (step > TASK_ROUTING_WINDOW_STEPS) {
      this.removeTaskRoutingResolutionTools(runState, []);
      this.syncMount(context);
    }
    const request = buildDeterministicLoadRequest(state);
    const suppressTaskRoutingTools = hasCompletedTaskRoutingWindowToolUse(state);
    const requiredRoutingTools = suppressTaskRoutingTools || step > TASK_ROUTING_WINDOW_STEPS
      ? []
      : requiredRoutingMutationToolsForRuntimeMode(mode);
    const result = this.load(this.addTaskRoutingWindowTools(request, state, context), context);
    let prepared = mergeToolLoadResult(result, this.ensureToolsLoadedOutsideLimit(requiredRoutingTools, context));
    if (suppressTaskRoutingTools) {
      const removed: string[] = [];
      this.removeTaskRoutingTools(runState, removed);
      if (removed.length > 0) {
        this.syncMount(context);
        return {
          ...prepared,
          loaded: prepared.loaded.filter((tool) => !removed.includes(tool)),
          alreadyActive: prepared.alreadyActive.filter((tool) => !removed.includes(tool)),
          evicted: [...prepared.evicted, ...removed],
          message: `${prepared.message} Removed task routing tools after prior routing use: ${removed.join(", ")}.`,
        };
      }
    }
    const policyRemoved: string[] = [];
    this.removeToolsDisallowedForRuntimeMode(runState, mode, policyRemoved);
    if (policyRemoved.length > 0) {
      prepared = {
        ...prepared,
        loaded: prepared.loaded.filter((tool) => !policyRemoved.includes(tool)),
        alreadyActive: prepared.alreadyActive.filter((tool) => !policyRemoved.includes(tool)),
        evicted: normalizeStrings([...prepared.evicted, ...policyRemoved]),
        message: `${prepared.message} Removed tools disallowed for ${mode.name}: ${policyRemoved.join(", ")}.`,
      };
    }
    this.syncMount(context);
    return prepared;
  }

  load(request: ToolLoadRequest, context: ToolExecutionContext): ToolLoadResult {
    const state = this.getRunState(context);
    const normalized = normalizeRequest(request);
    if (normalized.toolNames.length === 0 && normalized.groups.length === 0 && !normalized.query) {
      return {
        status: "invalid_request",
        requested: normalized,
        loaded: [],
        alreadyActive: [],
        evicted: [],
        missing: [],
        message: this.summarizeLoadMessage("invalid_request", [], [], [], normalized),
      };
    }

    let resolved: { entries: ToolCatalogEntry[]; missing: string[] };
    try {
      resolved = this.resolveRequest(normalized);
    } catch (error) {
      return {
        status: "failed",
        requested: normalized,
        loaded: [],
        alreadyActive: [],
        evicted: [],
        missing: [],
        message: `Failed to resolve tool load request: ${error instanceof Error ? error.message : String(error)} ${this.availableGroupHint()}`.trim(),
      };
    }

    const loaded: string[] = [];
    const alreadyActive: string[] = [];
    const evicted: string[] = [];
    const missing = [...resolved.missing];

    for (const entry of resolved.entries) {
      if (state.ordered.includes(entry.name)) {
        alreadyActive.push(entry.name);
        continue;
      }
      while (state.ordered.length >= this.maxVisibleTools) {
        const removed = this.evictOneForIncomingTool(state, entry.name);
        if (!removed) {
          missing.push(`${entry.name} (visible tool limit)`);
          break;
        }
        evicted.push(removed);
        state.loadedAtStep.delete(removed);
        state.usedAtStep.delete(removed);
      }
      if (state.ordered.length >= this.maxVisibleTools) {
        continue;
      }
      state.ordered.push(entry.name);
      state.loadedAtStep.set(entry.name, context.stepNumber ?? 0);
      loaded.push(entry.name);
    }

    this.syncMount(context);
    const status = summarizeLoadStatus(loaded, alreadyActive, missing, resolved.entries.length);
    return {
      status,
      requested: normalized,
      loaded,
      alreadyActive,
      evicted,
      missing,
      message: this.summarizeLoadMessage(status, loaded, alreadyActive, missing, normalized, evicted),
    };
  }

  afterExecution(calls: ActToolCallRecord[], context: ToolExecutionContext): ToolLoadResult {
    const state = this.getRunState(context);
    const nextTools: string[] = [];
    const removeAfterUse = new Set<string>();

    for (const call of calls) {
      const entry = this.catalog.get(call.tool);
      if (!entry) {
        continue;
      }
      state.usedAtStep.set(entry.name, context.stepNumber ?? 0);
      if (!call.error && isTaskRoutingResolutionTool(entry.name)) {
        state.taskRouting.resolved = true;
      }
      nextTools.push(...(call.error ? entry.nextOnFailure : entry.nextOnSuccess));
      if (!call.error && (entry.deactivationPolicy === "success" || entry.deactivationPolicy === "one_step")) {
        removeAfterUse.add(entry.name);
      }
    }

    const result = nextTools.length > 0
      ? this.load({ toolNames: nextTools }, context)
      : {
        status: "not_needed" as const,
        requested: { toolNames: [], groups: [] },
        loaded: [],
        alreadyActive: [],
        evicted: [],
        missing: [],
        message: "No deterministic follow-up tools were needed.",
      };

    if (removeAfterUse.size > 0) {
      const keep = new Set(result.loaded);
      state.ordered = state.ordered.filter((tool) => !removeAfterUse.has(tool) || keep.has(tool));
      for (const tool of removeAfterUse) {
        if (!keep.has(tool)) {
          state.loadedAtStep.delete(tool);
        }
      }
      this.syncMount(context);
    }
    if (state.taskRouting.resolved) {
      this.removeTaskRoutingTools(state, []);
      this.syncMount(context);
    }

    return result;
  }

  cleanupAfterStep(context: ToolExecutionContext): string[] {
    const state = this.getRunState(context);
    const step = context.stepNumber ?? 0;
    const removed: string[] = [];
    state.ordered = state.ordered.filter((toolName) => {
      const entry = this.catalog.get(toolName);
      if (!entry || entry.deactivationPolicy !== "one_step") {
        return true;
      }
      const loadedAt = state.loadedAtStep.get(toolName) ?? step;
      const usedAt = state.usedAtStep.get(toolName);
      const shouldRemove = usedAt === step || loadedAt < step;
      if (shouldRemove) {
        removed.push(toolName);
        state.loadedAtStep.delete(toolName);
        state.usedAtStep.delete(toolName);
      }
      return !shouldRemove;
    });
    if (state.taskRouting.resolved) {
      this.removeTaskRoutingTools(state, removed);
    } else if (step >= TASK_ROUTING_WINDOW_STEPS) {
      this.removeTaskRoutingResolutionTools(state, removed);
    }
    this.syncMount(context);
    return removed;
  }

  private addTaskRoutingWindowTools(
    request: ToolLoadRequest,
    state: LoopState,
    context: ToolExecutionContext,
  ): ToolLoadRequest {
    const runState = this.getRunState(context);
    const mode = detectRuntimeCapabilityMode({ state });
    if (runState.taskRouting.resolved) {
      return request;
    }
    if (state.runId || state.harnessContext.contextEngine?.pendingTurn?.routingStatus === "bound") {
      return request;
    }
    if (state.harnessContext.contextEngine?.pendingTurn?.routingStatus === "clarifying") {
      return request;
    }
    if (hasCompletedTaskRoutingWindowToolUse(state)) {
      return request;
    }
    const step = context.stepNumber ?? 0;
    if (step < 1 || step > TASK_ROUTING_WINDOW_STEPS) {
      return request;
    }
    const routingTools = isFreshSessionRoutingMode(mode)
      ? GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES
      : TASK_ROUTING_WINDOW_TOOL_NAMES;
    return {
      ...request,
      toolNames: [
        ...(request.toolNames ?? []),
        ...routingTools,
      ],
    };
  }

  private removeTaskRoutingTools(state: RunToolState, removed: string[]): void {
    const before = state.ordered;
    state.ordered = state.ordered.filter((tool) => !isTaskRoutingWindowTool(tool));
    for (const tool of before) {
      if (!state.ordered.includes(tool) && isTaskRoutingWindowTool(tool)) {
        state.loadedAtStep.delete(tool);
        state.usedAtStep.delete(tool);
        removed.push(tool);
      }
    }
  }

  private removeTaskRoutingResolutionTools(state: RunToolState, removed: string[]): void {
    const before = state.ordered;
    state.ordered = state.ordered.filter((tool) => !isTaskRoutingResolutionTool(tool));
    for (const tool of before) {
      if (!state.ordered.includes(tool) && isTaskRoutingResolutionTool(tool)) {
        state.loadedAtStep.delete(tool);
        state.usedAtStep.delete(tool);
        removed.push(tool);
      }
    }
  }

  private removeToolsDisallowedForRuntimeMode(
    state: RunToolState,
    mode: ReturnType<typeof detectRuntimeCapabilityMode>,
    removed: string[],
  ): void {
    const before = state.ordered;
    state.ordered = state.ordered.filter((tool) => isRuntimeToolAllowed(mode, tool));
    for (const tool of before) {
      if (!state.ordered.includes(tool)) {
        state.loadedAtStep.delete(tool);
        state.usedAtStep.delete(tool);
        removed.push(tool);
      }
    }
  }

  private ensureToolsLoadedOutsideLimit(toolNames: string[], context: ToolExecutionContext): Pick<ToolLoadResult, "loaded" | "alreadyActive" | "missing"> {
    const state = this.getRunState(context);
    const loaded: string[] = [];
    const alreadyActive: string[] = [];
    const missing: string[] = [];

    for (const name of normalizeStrings(toolNames)) {
      const entry = this.catalog.get(name);
      if (!entry) {
        missing.push(name);
        continue;
      }
      if (state.ordered.includes(entry.name)) {
        alreadyActive.push(entry.name);
        continue;
      }
      state.ordered.push(entry.name);
      state.loadedAtStep.set(entry.name, context.stepNumber ?? 0);
      loaded.push(entry.name);
    }

    if (loaded.length > 0) {
      this.syncMount(context);
    }
    return { loaded, alreadyActive, missing };
  }

  private evictOneForIncomingTool(state: RunToolState, incomingTool: string): string | undefined {
    const incomingPriority = toolPriority(this.catalog.get(incomingTool)?.name ?? incomingTool);
    const candidates = state.ordered
      .filter((tool) => !isTaskRoutingResolutionTool(tool))
      .map((tool, index) => ({
        tool,
        index,
        priority: toolPriority(tool),
        loadedAt: state.loadedAtStep.get(tool) ?? 0,
      }))
      .sort((left, right) => (
        left.priority - right.priority
        || left.loadedAt - right.loadedAt
        || right.index - left.index
      ));
    const candidate = candidates[0];
    if (!candidate || candidate.priority > incomingPriority) {
      return undefined;
    }
    state.ordered = state.ordered.filter((tool) => tool !== candidate.tool);
    return candidate.tool;
  }

  private resolveRequest(request: Required<Pick<ToolLoadRequest, "toolNames" | "groups">> & Pick<ToolLoadRequest, "query">): { entries: ToolCatalogEntry[]; missing: string[] } {
    const entries = new Map<string, ToolCatalogEntry>();
    const missing: string[] = [];

    for (const name of request.toolNames) {
      const entry = this.catalog.get(name);
      if (entry) {
        entries.set(entry.name, entry);
      } else {
        missing.push(name);
      }
    }

    for (const group of request.groups) {
      const groupEntries = this.catalog.toolsForGroup(group);
      if (groupEntries.length === 0) {
        missing.push(`group:${group}`);
      }
      for (const entry of groupEntries) {
        entries.set(entry.name, entry);
      }
    }

    if (entries.size === 0 && request.query?.trim()) {
      for (const result of this.catalog.search(request.query, Math.max(4, this.maxVisibleTools))) {
        entries.set(result.entry.name, result.entry);
      }
    }

    return { entries: [...entries.values()].slice(0, this.maxVisibleTools), missing };
  }

  private summarizeLoadMessage(
    status: ToolLoadStatus,
    loaded: string[],
    alreadyActive: string[],
    missing: string[],
    request: Required<Pick<ToolLoadRequest, "toolNames" | "groups">> & Pick<ToolLoadRequest, "query">,
    evicted: string[] = [],
  ): string {
    const base = summarizeLoadMessage(status, loaded, alreadyActive, missing);
    const parts = [base];
    if (evicted.length > 0) {
      parts.push(`Evicted lower-priority tools to stay within the ${this.maxVisibleTools}-tool working set: ${evicted.join(", ")}.`);
    }
    if (status === "already_active" && alreadyActive.length > 0) {
      parts.push(`Use the already active tools now instead of loading them again: ${alreadyActive.slice(0, 8).join(", ")}.`);
    }
    if (missing.length > 0 || status === "no_match" || status === "invalid_request") {
      const missingGroups = request.groups.filter((group) => this.catalog.toolsForGroup(group).length === 0);
      if (missingGroups.length > 0) {
        parts.push(`Unknown groups: ${missingGroups.join(", ")}.`);
      }
      parts.push(this.availableGroupHint());
    }
    if (request.groups.length > 1) {
      parts.push("Multiple groups are supported; prefer 1-3 small groups such as file:read + file:write + shell:command.");
    }
    return parts.filter((part) => part.length > 0).join(" ");
  }

  private availableGroupHint(): string {
    const groups = this.catalog.groupSummaries(12);
    if (groups.length === 0) {
      return "No loadable groups are registered.";
    }
    return `Available groups include: ${groups.join("; ")}.`;
  }

  private getRunState(context: ToolExecutionContext): RunToolState {
    const runId = readRunId(context);
    const existing = this.runs.get(runId);
    if (existing) {
      return existing;
    }
    const created: RunToolState = {
      ordered: [],
      loadedAtStep: new Map(),
      usedAtStep: new Map(),
      taskRouting: {
        resolved: false,
      },
    };
    this.runs.set(runId, created);
    return created;
  }

  private syncMount(context: ToolExecutionContext): void {
    const runId = readRunId(context);
    const state = this.getRunState(context);
    const tools = state.ordered
      .map((name) => this.catalog.getTool(name))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
    this.toolExecutor.mount?.(this.groupId(runId), tools, {
      scope: "run",
      runId,
      sessionId: context.sessionId,
      activatedAtStep: context.stepNumber,
      skillId: "working-set",
      toolIds: state.ordered,
      description: "Run-scoped visible tool working set.",
    });
  }

  private groupId(runId: string): string {
    return `dynamic:working-set:${runId}`;
  }
}

function buildDeterministicLoadRequest(state: LoopState): ToolLoadRequest {
  const mode = detectRuntimeCapabilityMode({ state });
  const modeTools = deterministicToolsForRuntimeMode(mode);
  if (modeTools) {
    return {
      toolNames: modeTools,
    };
  }
  const pendingTurnStatus = state.harnessContext.contextEngine?.pendingTurn?.routingStatus;
  if (pendingTurnStatus === "unbound") {
    return {
      toolNames: [
        ...GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
        ...GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
      ],
    };
  }
  if (pendingTurnStatus === "clarifying") {
    return {};
  }

  const text = [
    state.userMessage,
    state.workState.summary,
    state.workState.nextStep,
    ...(state.workState.openWork ?? []),
    ...(state.workState.blockers ?? []),
    ...(state.workState.taskNotes ?? []).flatMap((note) => [note.text, note.source]),
    ...(state.failureHistory.slice(-2).flatMap((failure) => [failure.reason, ...failure.blockedTargets])),
  ].join(" ").toLowerCase();

  const toolNames = new Set<string>();
  const groups = new Set<string>();

  if (hasRecoverableCompactedRunToolCall(state.toolContext?.toolCalls)) {
    toolNames.add(RUN_STEP_RECOVERY_TOOL_NAME);
  }

  if (/\b(find|search|where|locate)\b/.test(text)) {
    toolNames.add("inspect_paths");
    toolNames.add("find_files");
    toolNames.add("search_in_files");
  }
  if (/\b(read|open|show|inspect|view)\b/.test(text)) {
    toolNames.add("inspect_paths");
    toolNames.add("find_files");
    toolNames.add("read_files");
    toolNames.add("read_file");
  }
  if (/\b(edit|fix|update|modify|refactor|change)\b/.test(text)) {
    toolNames.add("inspect_paths");
    toolNames.add("find_files");
    toolNames.add("search_in_files");
    toolNames.add("read_files");
    toolNames.add("read_file");
    toolNames.add("edit_file");
  }
  if (hasFileCreationIntent(text)) {
    groups.add("file:create");
    groups.add("file:write");
    groups.add("file:read");
  } else if (/\b(create|write|generate|save)\b/.test(text)) {
    groups.add("file:write");
  }
  if (hasShellCommandIntent(text)) {
    groups.add("shell:command");
    groups.add("file:verify");
  }
  if (/\b(pdf|docx|document|summari[sz]e|section|citation)\b/.test(text) || hasPreparedDocument(state)) {
    toolNames.add("attachment_restore");
    toolNames.add("document_query");
    toolNames.add("document_read_section");
  }
  if (/\b(csv|xlsx|dataset|table|rows|columns|dataframe|statistics|plot|chart)\b/.test(text) || hasPreparedDataset(state)) {
    toolNames.add("attachment_restore");
    toolNames.add("dataset_profile");
    toolNames.add("dataset_query");
  }
  if (/\b(sql|sqlite|database|db)\b/.test(text)) {
    groups.add("skill:database");
  }
  if (/\b(memory|remember|recall|forget|preference)\b/.test(text)) {
    groups.add("domain:memory");
    groups.add("domain:recall");
  }
  if (hasUiWorkspaceIntent(text)) {
    groups.add("workflow:ui_workspace");
  }
  if (hasAttachmentWork(state)) {
    toolNames.add("attachment_restore");
    toolNames.add("attachment_list");
    toolNames.add("attachment_read");
  }

  return {
    toolNames: [...toolNames],
    groups: [...groups],
    ...(text.trim() ? { query: text } : {}),
  };
}

function hasFileCreationIntent(text: string): boolean {
  const hasCreationVerb = /\b(build|create|make|generate|write|save|scaffold|set up|setup)\b/.test(text);
  if (!hasCreationVerb) {
    return false;
  }
  return /\b(website|web site|site|app|application|project|page|dashboard|component|script|file|files|folder|directory|html|css|js|javascript|typescript|react|vue|svelte|vanilla)\b/.test(text);
}

function hasShellCommandIntent(text: string): boolean {
  if (/\b(run|execute|test|install|start|serve|launch|compile|terminal|command|server)\b/.test(text)) {
    return true;
  }
  if (/\b(run|execute)\s+(the\s+)?build\b|\bbuild\s+(command|script|step|pipeline)\b/.test(text)) {
    return true;
  }
  return /\b(npm|pnpm|yarn|bun|node|deno|python|pytest|vitest|jest|cargo|go test|make|docker|git)\b/.test(text);
}

function hasUiWorkspaceIntent(text: string): boolean {
  if (/\b(window|workspace|preview|focus|layout)\b/.test(text)) {
    return true;
  }
  return /\b(open|show|launch|view)\s+(it\s+)?(in\s+)?(the\s+)?browser\b|\bbrowser\s+(preview|window)\b/.test(text);
}

function normalizeRequest(request: ToolLoadRequest): Required<Pick<ToolLoadRequest, "toolNames" | "groups">> & Pick<ToolLoadRequest, "query"> {
  const query = request.query?.trim();
  return {
    toolNames: normalizeStrings(request.toolNames),
    groups: normalizeStrings(request.groups),
    ...(query ? { query } : {}),
  };
}

function normalizeStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

function toolPriority(toolName: string): number {
  return getToolLoadPriority(toolName) ?? 50;
}

function mergeToolLoadResult(
  result: ToolLoadResult,
  pinned: Pick<ToolLoadResult, "loaded" | "alreadyActive" | "missing">,
): ToolLoadResult {
  if (pinned.loaded.length === 0 && pinned.alreadyActive.length === 0 && pinned.missing.length === 0) {
    return result;
  }
  return {
    ...result,
    loaded: normalizeStrings([...result.loaded, ...pinned.loaded]),
    alreadyActive: normalizeStrings([...result.alreadyActive, ...pinned.alreadyActive]),
    missing: normalizeStrings([...result.missing, ...pinned.missing]),
    message: summarizeLoadMessage(
      summarizeLoadStatus(
        normalizeStrings([...result.loaded, ...pinned.loaded]),
        normalizeStrings([...result.alreadyActive, ...pinned.alreadyActive]),
        normalizeStrings([...result.missing, ...pinned.missing]),
        result.loaded.length + result.alreadyActive.length + pinned.loaded.length + pinned.alreadyActive.length,
      ),
      normalizeStrings([...result.loaded, ...pinned.loaded]),
      normalizeStrings([...result.alreadyActive, ...pinned.alreadyActive]),
      normalizeStrings([...result.missing, ...pinned.missing]),
    ),
  };
}

function isTaskRoutingWindowTool(tool: string): boolean {
  return (TASK_ROUTING_WINDOW_TOOL_NAMES as readonly string[]).includes(tool);
}

function hasCompletedTaskRoutingWindowToolUse(state: LoopState): boolean {
  return state.completedSteps.some((step) => (step.toolsUsed ?? []).some(isTaskRoutingResolutionTool));
}

function isTaskRoutingResolutionTool(tool: string): boolean {
  return isGitContextTurnRoutingToolName(tool);
}

function summarizeLoadStatus(
  loaded: string[],
  alreadyActive: string[],
  missing: string[],
  matchedCount: number,
): ToolLoadStatus {
  if ((loaded.length > 0 || alreadyActive.length > 0) && missing.length > 0) return "partial";
  if (loaded.length > 0) return "loaded";
  if (alreadyActive.length > 0 && missing.length === 0) return "already_active";
  if (matchedCount === 0) return "no_match";
  return missing.length > 0 ? "no_match" : "loaded";
}

function summarizeLoadMessage(
  status: ToolLoadStatus,
  loaded: string[],
  alreadyActive: string[],
  missing: string[],
): string {
  switch (status) {
    case "loaded":
      return `Loaded tools: ${loaded.join(", ")}.`;
    case "partial":
      return [
        loaded.length > 0 ? `Loaded tools: ${loaded.join(", ")}.` : "",
        alreadyActive.length > 0 ? `Already active tools: ${alreadyActive.join(", ")}.` : "",
        `Missing selectors: ${missing.join(", ")}.`,
      ].filter((part) => part.length > 0).join(" ");
    case "already_active":
      return `Requested tools were already active: ${alreadyActive.join(", ")}.`;
    case "no_match":
      return missing.length > 0
        ? `No new tools matched the request. Missing selectors: ${missing.join(", ")}.`
        : "No tools matched the request.";
    case "invalid_request":
      return "load_tools requires at least one non-empty selector: groups, toolNames, or query.";
    case "failed":
      return "Tool loading failed.";
    case "not_needed":
      return "No tool loading was needed.";
  }
}

function hasAttachmentWork(state: LoopState): boolean {
  return (state.attachedDocuments?.length ?? 0) > 0
    || (state.preparedAttachments?.length ?? 0) > 0
    || (state.preparedAttachmentRecords?.length ?? 0) > 0
    || (state.managedFiles?.length ?? 0) > 0
    || (state.managedDirectories?.length ?? 0) > 0
    || (state.harnessContext.contextEngine?.task?.assets.length ?? 0) > 0;
}

function hasPreparedDocument(state: LoopState): boolean {
  return (state.preparedAttachments ?? []).some((attachment) => Boolean(attachment.unstructured));
}

function hasPreparedDataset(state: LoopState): boolean {
  return (state.preparedAttachments ?? []).some((attachment) => Boolean(attachment.structured));
}

function readRunId(context: ToolExecutionContext): string {
  if (!context.runId) {
    throw new Error("tool working set requires runId in context.");
  }
  return context.runId;
}
