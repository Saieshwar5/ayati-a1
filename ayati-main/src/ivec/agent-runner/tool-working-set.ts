import type { ToolExecutionContext, ToolDefinition } from "../../skills/types.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import type { ActToolCallRecord, LoopState } from "../types.js";
import type { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.js";

export interface ToolLoadRequest {
  query?: string;
  toolNames?: string[];
  groups?: string[];
  reason?: string;
}

export interface ToolWorkingSetManagerOptions {
  catalog: ToolCatalog;
  toolExecutor: ToolExecutor;
  maxVisibleTools?: number;
}

export interface ToolLoadResult {
  loaded: string[];
  alreadyActive: string[];
  evicted: string[];
  missing: string[];
  reason: string;
}

interface RunToolState {
  ordered: string[];
  loadedAtStep: Map<string, number>;
  usedAtStep: Map<string, number>;
}

const DEFAULT_MAX_VISIBLE_TOOLS = 12;

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
    const request = buildDeterministicLoadRequest(state);
    const result = this.load(request, context);
    this.syncMount(context);
    return result;
  }

  load(request: ToolLoadRequest, context: ToolExecutionContext): ToolLoadResult {
    const state = this.getRunState(context);
    const resolved = this.resolveRequest(request);
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
    return {
      loaded,
      alreadyActive,
      evicted,
      missing,
      reason: request.reason ?? request.query ?? "tool load",
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
      nextTools.push(...(call.error ? entry.nextOnFailure : entry.nextOnSuccess));
      if (!call.error && (entry.deactivationPolicy === "success" || entry.deactivationPolicy === "one_step")) {
        removeAfterUse.add(entry.name);
      }
    }

    const result = this.load({
      toolNames: nextTools,
      reason: "deterministic follow-up tools from executed tool results",
    }, context);

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
    this.syncMount(context);
    return removed;
  }

  private resolveRequest(request: ToolLoadRequest): { entries: ToolCatalogEntry[]; missing: string[] } {
    const entries = new Map<string, ToolCatalogEntry>();
    const missing: string[] = [];

    for (const name of request.toolNames ?? []) {
      const entry = this.catalog.get(name);
      if (entry) {
        entries.set(entry.name, entry);
      } else {
        missing.push(name);
      }
    }

    for (const group of request.groups ?? []) {
      for (const entry of this.catalog.toolsForGroup(group)) {
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
  const text = [
    state.userMessage,
    state.workState.summary,
    state.workState.nextStep,
    ...(state.workState.openWork ?? []),
    ...(state.workState.blockers ?? []),
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
  if (/\b(course|lesson|study|learning)\b/.test(text)) {
    groups.add("workflow:learning");
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
    query: text,
    reason: "deterministic preload from task state",
  };
}

function hasAttachmentWork(state: LoopState): boolean {
  return (state.attachedDocuments?.length ?? 0) > 0
    || (state.preparedAttachments?.length ?? 0) > 0
    || (state.preparedAttachmentRecords?.length ?? 0) > 0
    || (state.managedFiles?.length ?? 0) > 0
    || (state.managedDirectories?.length ?? 0) > 0
    || (state.continuity?.current?.topAssets?.length ?? 0) > 0
    || (state.continuity?.candidates ?? []).some((candidate) => candidate.topAssets.length > 0);
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
