import type { ToolExecutionContext, ToolDefinition } from "../../skills/types.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import type { ActToolCallRecord, LoopState } from "../types.js";
import type { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.js";
import {
  GIT_CONTEXT_FRESH_SESSION_ROUTING_TOOL_NAMES,
  GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
} from "../../skills/builtins/git-context/tool-policy.js";
import {
  detectRuntimeCapabilityMode,
  deterministicToolsForRuntimeMode,
  isFreshSessionRoutingMode,
} from "./runtime-capability-mode.js";

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

const DEFAULT_MAX_VISIBLE_TOOLS = 12;
const TASK_ROUTING_WINDOW_STEPS = 2;
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
    if (step > TASK_ROUTING_WINDOW_STEPS) {
      this.removeTaskRoutingTools(runState, []);
      this.syncMount(context);
    }
    const request = buildDeterministicLoadRequest(state);
    const suppressTaskRoutingTools = hasCompletedTaskRoutingWindowToolUse(state);
    const result = this.load(this.addTaskRoutingWindowTools(request, state, context), context);
    if (suppressTaskRoutingTools) {
      const removed: string[] = [];
      this.removeTaskRoutingTools(runState, removed);
      if (removed.length > 0) {
        this.syncMount(context);
        return {
          ...result,
          loaded: result.loaded.filter((tool) => !removed.includes(tool)),
          alreadyActive: result.alreadyActive.filter((tool) => !removed.includes(tool)),
          evicted: [...result.evicted, ...removed],
          message: `${result.message} Removed task routing tools after prior routing use: ${removed.join(", ")}.`,
        };
      }
    }
    this.syncMount(context);
    return result;
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
        message: "load_tools requires at least one non-empty selector: groups, toolNames, or query.",
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
        message: `Failed to resolve tool load request: ${error instanceof Error ? error.message : String(error)}`,
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
        const removed = state.ordered.pop();
        if (!removed) break;
        evicted.push(removed);
        state.loadedAtStep.delete(removed);
        state.usedAtStep.delete(removed);
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
      message: summarizeLoadMessage(status, loaded, alreadyActive, missing),
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
      if (!call.error && isTaskRoutingWindowTool(entry.name)) {
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
    if (state.taskRouting.resolved || step >= TASK_ROUTING_WINDOW_STEPS) {
      this.removeTaskRoutingTools(state, removed);
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
    if (runState.taskRouting.resolved) {
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
    const mode = detectRuntimeCapabilityMode({ state });
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

  if (/\b(find|search|where|locate)\b/.test(text)) {
    toolNames.add("find_files");
    toolNames.add("search_in_files");
  }
  if (/\b(read|open|show|inspect|view)\b/.test(text)) {
    toolNames.add("find_files");
    toolNames.add("read_file");
  }
  if (/\b(edit|fix|update|modify|refactor|change)\b/.test(text)) {
    toolNames.add("find_files");
    toolNames.add("search_in_files");
    toolNames.add("read_file");
    toolNames.add("edit_file");
  }
  if (/\b(create|write|generate|save)\b/.test(text)) {
    toolNames.add("write_file");
    toolNames.add("write_files");
    toolNames.add("create_directory");
  }
  if (/\b(run|test|build|install|command|terminal|server)\b/.test(text)) {
    toolNames.add("shell_run_script");
    toolNames.add("shell");
    toolNames.add("search_in_files");
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
  if (/\b(window|workspace|browser|preview|show|focus|layout)\b/.test(text)) {
    groups.add("workflow:ui_workspace");
  }
  if ((state.workState.evidenceRefs ?? []).length > 0) {
    toolNames.add("evidence_search");
    toolNames.add("evidence_read_lines");
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

function isTaskRoutingWindowTool(tool: string): boolean {
  return (TASK_ROUTING_WINDOW_TOOL_NAMES as readonly string[]).includes(tool);
}

function hasCompletedTaskRoutingWindowToolUse(state: LoopState): boolean {
  return state.completedSteps.some((step) => (step.toolsUsed ?? []).some(isTaskRoutingWindowTool));
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
