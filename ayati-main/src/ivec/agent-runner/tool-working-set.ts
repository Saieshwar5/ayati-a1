import type { ToolExecutionContext, ToolDefinition } from "../../skills/types.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import type { ActToolCallRecord, LoopState } from "../types.js";
import type { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.js";
import { getToolLoadPriority } from "../../skills/tool-taxonomy.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  isGitContextRoutingToolName,
  isToolAllowedByWorkstreamBinding,
  type WorkstreamBindingCapabilityPolicy,
} from "./workstream-binding-capability-policy.js";

export interface ToolLoadRequest {
  query?: string;
  toolNames?: string[];
  groups?: string[];
}

export type ToolLoadStatus = "loaded" | "partial" | "already_active" | "unavailable" | "no_match" | "invalid_request" | "failed" | "not_needed";

export type ToolLoadUnavailableReason =
  | "requires_workstream_binding"
  | "not_available_after_workstream_binding"
  | "routing_unavailable";

export interface ToolLoadUnavailable {
  tool: string;
  reason: ToolLoadUnavailableReason;
}

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
  unavailable: ToolLoadUnavailable[];
  message: string;
}

interface RunToolState {
  ordered: string[];
  loadedAtStep: Map<string, number>;
  usedAtStep: Map<string, number>;
}

const DEFAULT_MAX_VISIBLE_TOOLS = 15;

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

  getPromptSummary(options: { compact?: boolean } = {}): string {
    return this.catalog.promptSummary(options);
  }

  getCapabilitySummary(): string {
    return this.catalog.capabilitySummary();
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

  prepareForDecision(
    state: LoopState,
    context: ToolExecutionContext,
  ): ToolLoadResult {
    const runState = this.getRunState(context);
    const policy = deriveWorkstreamBindingCapabilityPolicy(state);
    let prepared = notNeededToolLoadResult();
    const policyRemoved: string[] = [];
    this.removeToolsDisallowedByWorkstreamBinding(runState, policy, policyRemoved);
    if (policyRemoved.length > 0) {
      prepared = {
        ...prepared,
        loaded: prepared.loaded.filter((tool) => !policyRemoved.includes(tool)),
        alreadyActive: prepared.alreadyActive.filter((tool) => !policyRemoved.includes(tool)),
        evicted: normalizeStrings([...prepared.evicted, ...policyRemoved]),
        message: `${prepared.message} Removed tools disallowed by workstream binding: ${policyRemoved.join(", ")}.`,
      };
    }
    this.syncMount(context);
    return prepared;
  }

  resolveCapabilityTools(capabilities: string[]): {
    toolNames: string[];
    missingCapabilities: string[];
  } {
    const toolNames = new Set<string>();
    const missingCapabilities: string[] = [];
    for (const capability of normalizeStrings(capabilities)) {
      const entries = this.catalog.toolsForGroup(capability);
      if (entries.length === 0) {
        missingCapabilities.push(capability);
        continue;
      }
      for (const entry of entries) {
        toolNames.add(entry.name);
      }
    }
    return {
      toolNames: [...toolNames],
      missingCapabilities,
    };
  }

  replaceWithTools(
    toolNames: string[],
    context: ToolExecutionContext,
    policy: WorkstreamBindingCapabilityPolicy,
  ): ToolLoadResult {
    const state = this.getRunState(context);
    const evicted = [...state.ordered];
    state.ordered = [];
    state.loadedAtStep.clear();
    state.usedAtStep.clear();
    this.syncMount(context);
    const result = this.load({ toolNames: normalizeStrings(toolNames) }, context, policy);
    return {
      ...result,
      evicted: evicted.filter((tool) => !result.loaded.includes(tool)),
      message: evicted.length > 0
        ? `${result.message} Replaced the previous mode tool surface.`
        : result.message,
    };
  }

  load(
    request: ToolLoadRequest,
    context: ToolExecutionContext,
    policy: WorkstreamBindingCapabilityPolicy,
  ): ToolLoadResult {
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
        unavailable: [],
        message: this.summarizeLoadMessage("invalid_request", [], [], [], [], normalized),
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
        unavailable: [],
        message: `Failed to resolve tool load request: ${error instanceof Error ? error.message : String(error)} ${this.availableGroupHint()}`.trim(),
      };
    }

    const loaded: string[] = [];
    const alreadyActive: string[] = [];
    const evicted: string[] = [];
    const missing = [...resolved.missing];
    const unavailable = resolved.entries
      .filter((entry) => !isToolAllowedByWorkstreamBinding(policy, entry.name))
      .map((entry): ToolLoadUnavailable => ({
        tool: entry.name,
        reason: unavailableReason(policy, entry.name),
      }));
    const availableEntries = resolved.entries.filter(
      (entry) => isToolAllowedByWorkstreamBinding(policy, entry.name),
    );

    for (const entry of availableEntries) {
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
    const status = summarizeLoadStatus(
      loaded,
      alreadyActive,
      missing,
      unavailable,
      availableEntries.length,
    );
    return {
      status,
      requested: normalized,
      loaded,
      alreadyActive,
      evicted,
      missing,
      unavailable,
      message: this.summarizeLoadMessage(
        status,
        loaded,
        alreadyActive,
        missing,
        unavailable,
        normalized,
        evicted,
      ),
    };
  }

  afterExecution(
    calls: ActToolCallRecord[],
    context: ToolExecutionContext,
    policy: WorkstreamBindingCapabilityPolicy,
  ): ToolLoadResult {
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

    const result = nextTools.length > 0
      ? this.load({ toolNames: nextTools }, context, policy)
      : {
        status: "not_needed" as const,
        requested: { toolNames: [], groups: [] },
        loaded: [],
        alreadyActive: [],
        evicted: [],
        missing: [],
        unavailable: [],
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

  private removeToolsDisallowedByWorkstreamBinding(
    state: RunToolState,
    policy: WorkstreamBindingCapabilityPolicy,
    removed: string[],
  ): void {
    const before = state.ordered;
    state.ordered = state.ordered.filter((tool) => isToolAllowedByWorkstreamBinding(policy, tool));
    for (const tool of before) {
      if (!state.ordered.includes(tool)) {
        state.loadedAtStep.delete(tool);
        state.usedAtStep.delete(tool);
        removed.push(tool);
      }
    }
  }

  private evictOneForIncomingTool(state: RunToolState, incomingTool: string): string | undefined {
    const incomingPriority = toolPriority(this.catalog.get(incomingTool)?.name ?? incomingTool);
    const candidates = state.ordered
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
    unavailable: ToolLoadUnavailable[],
    request: Required<Pick<ToolLoadRequest, "toolNames" | "groups">> & Pick<ToolLoadRequest, "query">,
    evicted: string[] = [],
  ): string {
    const base = summarizeLoadMessage(status, loaded, alreadyActive, missing, unavailable);
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
      parts.push("Multiple groups are supported; prefer 1-3 small groups such as file:read + file:write + process:command.");
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

function summarizeLoadStatus(
  loaded: string[],
  alreadyActive: string[],
  missing: string[],
  unavailable: ToolLoadUnavailable[],
  matchedCount: number,
): ToolLoadStatus {
  if ((loaded.length > 0 || alreadyActive.length > 0) && (missing.length > 0 || unavailable.length > 0)) return "partial";
  if (loaded.length > 0) return "loaded";
  if (alreadyActive.length > 0 && missing.length === 0 && unavailable.length === 0) return "already_active";
  if (unavailable.length > 0) return "unavailable";
  if (matchedCount === 0) return "no_match";
  return missing.length > 0 ? "no_match" : "loaded";
}

function summarizeLoadMessage(
  status: ToolLoadStatus,
  loaded: string[],
  alreadyActive: string[],
  missing: string[],
  unavailable: ToolLoadUnavailable[],
): string {
  const unavailableText = formatUnavailableTools(unavailable);
  switch (status) {
    case "loaded":
      return `Loaded tools: ${loaded.join(", ")}.`;
    case "partial":
      return [
        loaded.length > 0 ? `Loaded tools: ${loaded.join(", ")}.` : "",
        alreadyActive.length > 0 ? `Already active tools: ${alreadyActive.join(", ")}.` : "",
        missing.length > 0 ? `Missing selectors: ${missing.join(", ")}.` : "",
        unavailable.length > 0 ? `Unavailable in the current run phase: ${unavailableText}.` : "",
      ].filter((part) => part.length > 0).join(" ");
    case "already_active":
      return `Requested tools were already active: ${alreadyActive.join(", ")}.`;
    case "unavailable":
      return `Requested tools are unavailable in the current run phase: ${unavailableText}.`;
    case "no_match":
      return missing.length > 0
        ? `No new tools matched the request. Missing selectors: ${missing.join(", ")}.`
        : "No tools matched the request.";
    case "invalid_request":
      return "A capability request requires at least one exact capability group.";
    case "failed":
      return "Tool loading failed.";
    case "not_needed":
      return "No tool loading was needed.";
  }
}

function unavailableReason(
  policy: WorkstreamBindingCapabilityPolicy,
  toolName: string,
): ToolLoadUnavailableReason {
  if (policy.workstreamBound) {
    return "not_available_after_workstream_binding";
  }
  if (isGitContextRoutingToolName(toolName)) {
    return "routing_unavailable";
  }
  return "requires_workstream_binding";
}

function formatUnavailableTools(unavailable: ToolLoadUnavailable[]): string {
  return unavailable
    .map((entry) => `${entry.tool} (${entry.reason.replace(/_/g, " ")})`)
    .join(", ");
}

function notNeededToolLoadResult(): ToolLoadResult {
  return {
    status: "not_needed",
    requested: { toolNames: [], groups: [] },
    loaded: [],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    message: "No mode transition changed the tool surface.",
  };
}

function readRunId(context: ToolExecutionContext): string {
  if (!context.runId) {
    throw new Error("tool working set requires runId in context.");
  }
  return context.runId;
}
