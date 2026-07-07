import type { LoopState, TaskNote, ToolContextState, ToolObservation, WorkState } from "../types.js";
import type { MemoryRunHandle } from "../../memory/types.js";
import type { RepairPromptCard } from "./repair-policy.js";
import { buildPromptToolCallsForRun } from "./run-tool-call-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import {
  buildRuntimeCapabilityPromptContext,
  detectRuntimeCapabilityMode,
} from "./runtime-capability-mode.js";
import type { RuntimeCapabilityPromptContext } from "./runtime-capability-mode.js";
import type { ToolLoadResult } from "./tool-working-set.js";
import { buildAgentContextPack } from "./context-pack.js";
import { projectAgentPromptContext } from "./prompt-context.js";
import type {
  AgentPromptContext,
  PromptHarnessContext,
  PromptRunContext,
  PromptRunWorkStateContext,
  PromptToolsContext,
} from "./prompt-context.js";

export interface PromptProgressState extends PromptRunWorkStateContext {}

export interface PromptObservations {
  latest: ToolObservation[];
}

export interface PromptReadContext {
  latest: ToolObservation[];
}

export interface PromptToolLoadState {
  status: ToolLoadResult["status"];
  requested: ToolLoadResult["requested"];
  loaded: string[];
  alreadyActive: string[];
  evicted: string[];
  missing: string[];
  message: string;
}

export interface PromptTraceStep {
  step: number;
  mode?: "single" | "sequential" | "parallel";
  outcome: "success" | "failed";
  summary: string;
  toolCalls?: {
    success: number;
    failed: number;
  };
  artifacts?: string[];
}

export interface PromptTraceFailure {
  step: number;
  failureType: string;
  code?: string;
  reason: string;
  blockedTargets: string[];
}

export interface PromptTrace {
  recentSteps?: PromptTraceStep[];
  recentFailures?: PromptTraceFailure[];
}

export interface PromptWorkingFeedbackItem {
  severity: "info" | "warning" | "error";
  source: "tool_load" | "tool_validation" | "tool_execution" | "verification";
  code?: string;
  message: string;
  retryHint?: string;
  repair?: RepairPromptCard;
}

export interface PromptWorkingFeedback {
  latest: PromptWorkingFeedbackItem[];
}

export interface AgentStateView {
  context: AgentPromptContext;
  progress?: PromptProgressState;
  workingFeedback?: PromptWorkingFeedback;
  toolLoad?: PromptToolLoadState;
  observations?: PromptObservations;
  readContext?: PromptReadContext;
  toolCalls?: PromptToolCalls;
  trace?: PromptTrace;
  attachments?: {
    incoming?: Array<{ id: string; name: string; kind: string; source: string; mimeType?: string; status: string }>;
    prepared?: Array<{ id: string; name: string; mode: string; status: string }>;
    managedFiles?: Array<{ id: string; name: string; kind: string; status: string }>;
    managedDirectories?: Array<{ id: string; name: string; rootPath: string; status: string }>;
    warnings?: string[];
  };
  systemEvent?: {
    source?: string;
    eventName?: string;
    summary?: string;
    requestedAction?: string;
    approvalRequired?: boolean;
    approvalState?: string;
  };
}

export interface AgentStateViewOptions {
  activeTools?: string[];
  runtimeMode?: RuntimeCapabilityPromptContext;
  workRunHandle?: MemoryRunHandle;
  sessionRunHandle?: MemoryRunHandle;
}

export function buildAgentStateView(state: LoopState, options: AgentStateViewOptions = {}): AgentStateView {
  const runtimeMode = options.runtimeMode
    ?? buildRuntimeCapabilityPromptContext(detectRuntimeCapabilityMode({
      state,
      workRunHandle: options.workRunHandle,
      sessionRunHandle: options.sessionRunHandle,
    }));
  const progress = buildProgressView(state.workState);
  const toolLoad = buildToolLoadView(state.lastToolLoad);
  const workingFeedback = buildWorkingFeedbackView(state);
  const observations = buildObservationsView(state.toolContext);
  const readContext = buildReadContextView(state.toolContext);
  const toolCalls = buildToolCallsView(state.toolContext);
  const trace = buildTraceView(state);
  const attachments = buildAttachmentState(state);
  const systemEvent = state.systemEvent ? {
    source: state.systemEvent.source,
    eventName: state.systemEvent.eventName,
    summary: state.systemEvent.summary,
    requestedAction: state.systemEventRequestedAction,
    approvalRequired: state.approvalRequired,
    approvalState: state.approvalState,
  } : undefined;
  const context = projectAgentPromptContext({
    context: buildAgentContextPack(state),
    runtimeMode,
    tools: buildToolsContext({
      activeTools: options.activeTools,
      toolLoad,
    }),
    harness: buildHarnessContext({
      workingFeedback,
    }),
    run: buildRunContext({
      status: state.workState.status,
      workState: progress,
      toolCalls,
    }),
  });

  return {
    context,
    ...(progress ? { progress } : {}),
    ...(workingFeedback ? { workingFeedback } : {}),
    ...(toolLoad ? { toolLoad } : {}),
    ...(observations ? { observations } : {}),
    ...(readContext ? { readContext } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(trace ? { trace } : {}),
    ...(attachments ? { attachments } : {}),
    ...(systemEvent ? { systemEvent } : {}),
  };
}

function buildToolsContext(input: {
  activeTools?: string[];
  toolLoad?: PromptToolLoadState;
}): PromptToolsContext | undefined {
  const active = [...new Set(input.activeTools ?? [])]
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (active.length === 0 && !input.toolLoad) {
    return undefined;
  }
  return {
    active,
    ...(input.toolLoad ? { lastLoad: input.toolLoad } : {}),
  };
}

function buildRunContext(input: {
  status: WorkState["status"];
  workState?: PromptProgressState;
  toolCalls?: PromptToolCalls;
}): PromptRunContext {
  return {
    status: input.status,
    ...(input.workState ? { workState: input.workState } : {}),
    ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
  };
}

function buildHarnessContext(input: {
  workingFeedback?: PromptWorkingFeedback;
}): PromptHarnessContext | undefined {
  if (!input.workingFeedback) {
    return undefined;
  }
  return {
    feedback: input.workingFeedback,
  };
}

function buildWorkingFeedbackView(state: LoopState): PromptWorkingFeedback | undefined {
  const latest: PromptWorkingFeedbackItem[] = [];
  const pendingTurnFeedback = buildPendingTurnWorkingFeedback(state);
  if (pendingTurnFeedback) {
    latest.push(pendingTurnFeedback);
  }

  const toolLoadFeedback = buildToolLoadWorkingFeedback(state.lastToolLoad);
  if (toolLoadFeedback) {
    latest.push(toolLoadFeedback);
  }

  for (const failure of state.failureHistory.slice(-3)) {
    const repair = failure.repair;
    latest.push({
      severity: "error",
      source: failure.failureType === "validation_error" || isToolValidationReason(failure.reason)
        ? "tool_validation"
        : failure.failureType === "verify_failed" || failure.failureType === "no_progress"
          ? "verification"
          : "tool_execution",
      ...(failure.repairCode ? { code: failure.repairCode } : {}),
      message: truncate(repair?.message ?? failure.reason, 360),
      retryHint: repair?.allowedNextActions.join(" ") ?? buildFailureRetryHint(failure.failureType, failure.reason),
      ...(repair ? { repair } : {}),
    });
  }

  return latest.length > 0 ? { latest: latest.slice(-4) } : undefined;
}

function buildPendingTurnWorkingFeedback(state: LoopState): PromptWorkingFeedbackItem | undefined {
  const pendingTurn = state.harnessContext.contextEngine?.pendingTurn;
  if (pendingTurn?.routingStatus === "unbound") {
    return {
      severity: "warning",
      source: "tool_validation",
      message: "The current git-context pending turn is unbound. Normal task tools are not valid until this turn is routed to an existing task, a new task, or clarification.",
      retryHint: "Use git-context read/search tools if needed, then call git_context_activate_task_for_turn, git_context_create_task_for_turn, or git_context_ask_clarification_for_turn.",
    };
  }
  if (pendingTurn?.routingStatus === "clarifying") {
    return {
      severity: "warning",
      source: "tool_validation",
      message: "The current git-context pending turn is clarifying. Do not call executable tools while task ownership is unresolved.",
      retryHint: "Ask the user directly which task or target they mean.",
    };
  }
  return undefined;
}

function buildToolLoadWorkingFeedback(result: ToolLoadResult | undefined): PromptWorkingFeedbackItem | undefined {
  if (!result || ["loaded", "already_active"].includes(result.status)) {
    return undefined;
  }
  return {
    severity: result.status === "failed" ? "error" : "warning",
    source: "tool_load",
    message: truncate(result.message, 360),
    retryHint: result.missing.length > 0
      ? `Requested tools were not available: ${compactList(result.missing, 5, 80).join(", ")}. Use another selected tool or request a broader group/query.`
      : "If tools are still needed, request exact tool names, groups, or a clearer search query with decision_load_tools.",
  };
}

function isToolValidationReason(reason: string): boolean {
  return reason.includes("Invalid input for")
    || reason.includes("Tool input preflight failed")
    || reason.includes("missing required field")
    || reason.includes("No active task exists");
}

function buildFailureRetryHint(failureType: LoopState["failureHistory"][number]["failureType"], reason: string): string | undefined {
  if (reason.includes("No active task exists")) {
    return "Use git_context_create_task_for_turn first, or ask a short clarification if the request is unclear.";
  }
  if (failureType === "validation_error" || isToolValidationReason(reason)) {
    return "Retry the selected executable tool with all required schema fields. Do not use an empty input object.";
  }
  if (reason.includes("Unknown tool") || reason.includes("was not selected")) {
    return "Request the missing tool with decision_load_tools, then call the selected executable tool directly.";
  }
  if (reason.includes("permission")) {
    return "Ask the user only if the action requires permission or an irreversible change.";
  }
  if (reason.includes("verification") || reason.includes("validate")) {
    return "Use the latest observations and evidence to correct the next concrete tool call.";
  }
  return undefined;
}

function buildToolLoadView(result: ToolLoadResult | undefined): PromptToolLoadState | undefined {
  if (!result) {
    return undefined;
  }
  return {
    status: result.status,
    requested: {
      ...(result.requested.query ? { query: truncate(result.requested.query, 240) } : {}),
      toolNames: compactList(result.requested.toolNames, 12, 120),
      groups: compactList(result.requested.groups, 12, 120),
    },
    loaded: compactList(result.loaded, 12, 120),
    alreadyActive: compactList(result.alreadyActive, 12, 120),
    evicted: compactList(result.evicted, 12, 120),
    missing: compactList(result.missing, 12, 120),
    message: truncate(result.message, 360),
  };
}

function buildProgressView(workState: WorkState): PromptProgressState | undefined {
  const summary = truncate(workState.summary, 500);
  const openWork = compactList(workState.openWork, 5, 180);
  const blockers = compactList(workState.blockers, 4, 180);
  const verifiedFacts = compactList(workState.verifiedFacts, 6, 180);
  const evidence = compactList(workState.evidence, 5, 180);
  const artifacts = compactList(workState.artifacts, 6, 180);
  const taskNotes = compactTaskNotes(workState.taskNotes);
  const nextStep = workState.nextStep?.trim() ? truncate(workState.nextStep, 220) : undefined;
  const userInputNeeded = workState.userInputNeeded?.trim() ? truncate(workState.userInputNeeded, 220) : undefined;
  const hasUsefulState = workState.status !== "not_done"
    || summary.length > 0
    || openWork.length > 0
    || blockers.length > 0
    || verifiedFacts.length > 0
    || evidence.length > 0
    || artifacts.length > 0
    || taskNotes.length > 0
    || nextStep !== undefined
    || userInputNeeded !== undefined;

  if (!hasUsefulState) {
    return undefined;
  }

  return {
    status: workState.status,
    ...(summary.length > 0 ? { summary } : {}),
    ...(openWork.length > 0 ? { openWork } : {}),
    ...(blockers.length > 0 ? { blockers } : {}),
    ...(verifiedFacts.length > 0 ? { verifiedFacts } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(taskNotes.length > 0 ? { taskNotes } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(userInputNeeded ? { userInputNeeded } : {}),
  };
}

function compactTaskNotes(notes: TaskNote[] | undefined): TaskNote[] {
  return (notes ?? [])
    .filter((note) => note.id.trim().length > 0 && note.text.trim().length > 0)
    .slice(-6)
    .map((note) => ({
      id: truncate(note.id, 120),
      text: truncate(note.text, 300),
      source: truncate(note.source, 140),
      expires: note.expires,
    }));
}

function buildPromptObservations(observations: ToolObservation[] | undefined): ToolObservation[] {
  return (observations ?? [])
    .slice(-5)
    .map((observation) => ({
      ...observation,
      content: truncatePreserveLines(observation.content, 4_000),
    }));
}

function buildObservationsView(toolContext: ToolContextState | undefined): PromptObservations | undefined {
  const latest = buildPromptObservations(toolContext?.recent);
  return latest.length > 0 ? { latest } : undefined;
}

const READ_CONTEXT_TOOLS = new Set([
  "inspect_paths",
  "read_file",
  "read_files",
  "search_in_files",
  "find_files",
  "list_directory",
]);

function buildReadContextView(toolContext: ToolContextState | undefined): PromptReadContext | undefined {
  const latest = buildPromptObservations(
    (toolContext?.recent ?? []).filter((observation) => READ_CONTEXT_TOOLS.has(observation.tool)),
  );
  return latest.length > 0 ? { latest } : undefined;
}

function buildToolCallsView(toolContext: ToolContextState | undefined): PromptToolCalls | undefined {
  return buildPromptToolCallsForRun(toolContext?.toolCalls);
}

function buildTraceView(state: LoopState): PromptTrace | undefined {
  const recentSteps = buildRecentStepTrace(state);
  const recentFailures = buildRecentFailureTrace(state);
  if (recentSteps.length === 0 && recentFailures.length === 0) {
    return undefined;
  }
  return {
    ...(recentSteps.length > 0 ? { recentSteps } : {}),
    ...(recentFailures.length > 0 ? { recentFailures } : {}),
  };
}

function buildRecentStepTrace(state: LoopState): PromptTraceStep[] {
  return state.completedSteps.slice(-2).map((step) => {
    const toolSuccessCount = step.toolSuccessCount ?? 0;
    const toolFailureCount = step.toolFailureCount ?? 0;
    const mode = readActionMode(step.executionContract);
    return {
      step: step.step,
      ...(mode ? { mode } : {}),
      outcome: step.outcome === "success" ? "success" : "failed",
      summary: truncate(step.summary, 360),
      ...(toolSuccessCount > 0 || toolFailureCount > 0 ? {
        toolCalls: {
          success: toolSuccessCount,
          failed: toolFailureCount,
        },
      } : {}),
      ...(step.artifacts.length > 0 ? { artifacts: compactList(step.artifacts, 4, 180) } : {}),
    };
  });
}

function buildRecentFailureTrace(state: LoopState): PromptTraceFailure[] {
  return state.failureHistory.slice(-3).map((failure) => ({
    step: failure.step,
    failureType: failure.failureType,
    ...(failure.repairCode ? { code: failure.repairCode } : {}),
    reason: truncate(failure.reason, 300),
    blockedTargets: failure.blockedTargets,
  }));
}

function readActionMode(executionContract: string | undefined): PromptTraceStep["mode"] | undefined {
  const mode = executionContract?.match(/^(single|sequential|parallel) action:/)?.[1];
  if (mode === "single" || mode === "sequential" || mode === "parallel") {
    return mode;
  }
  return undefined;
}

function buildAttachmentState(state: LoopState): AgentStateView["attachments"] | undefined {
  const incoming = (state.attachedDocuments ?? []).slice(0, 8).map((document) => ({
    id: document.documentId,
    name: document.displayName,
    kind: document.kind,
    source: document.source,
    ...(document.mimeType?.trim() ? { mimeType: document.mimeType } : {}),
    status: "registered",
  }));
  const prepared = (state.preparedAttachments ?? []).slice(0, 8).map((attachment) => ({
    id: attachment.preparedInputId,
    name: attachment.displayName,
    mode: attachment.mode,
    status: attachment.status,
  }));
  const managedFiles = (state.managedFiles ?? []).slice(0, 8).map((file) => ({
    id: file.fileId,
    name: file.originalName,
    kind: file.kind,
    status: file.processingStatus,
  }));
  const managedDirectories = (state.managedDirectories ?? []).slice(0, 5).map((directory) => ({
    id: directory.directoryId,
    name: directory.name,
    rootPath: directory.rootPath,
    status: directory.status,
  }));
  const warnings = state.attachmentWarnings ?? [];

  if (
    incoming.length === 0
    && prepared.length === 0
    && managedFiles.length === 0
    && managedDirectories.length === 0
    && warnings.length === 0
  ) {
    return undefined;
  }

  return {
    ...(incoming.length > 0 ? { incoming } : {}),
    ...(prepared.length > 0 ? { prepared } : {}),
    ...(managedFiles.length > 0 ? { managedFiles } : {}),
    ...(managedDirectories.length > 0 ? { managedDirectories } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function compactList(values: string[] | undefined, limit: number, maxChars: number): string[] {
  return (values ?? []).slice(0, limit).map((value) => truncate(value, maxChars)).filter((value) => value.length > 0);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncatePreserveLines(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
