import type { LoopState, ToolContextState, ToolObservation } from "../types.js";
import type { RepairPromptCard } from "./repair-policy.js";
import { buildPromptToolCallsForRun } from "./run-tool-call-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import { applyRunContextProjectionOverlay } from "./run-context-maintenance-planner.js";
import { buildPromptVerifiedOutcomes } from "./run-verified-outcome-context.js";
import type { PromptVerifiedOutcomes } from "./run-verified-outcome-context.js";
import type { CapabilitySurfaceResult } from "./capabilities/contracts.js";
import { buildAgentContextPack } from "./context-pack.js";
import { buildBoundWorkstreamPromptContext } from "./bound-workstream-prompt-context.js";
import { projectAgentPromptContext } from "./prompt-context.js";
import { buildVirtualModeCard } from "./virtual-mode.js";
import { collectWorkstreamRoutingEvidence } from "./workstream-routing-evidence.js";
import { getActiveFailures } from "./failure-lifecycle.js";
import { hasMaterialWorkState } from "./work-state/selectors.js";
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

export interface PromptCapabilitySurfaceState {
  status: CapabilitySurfaceResult["status"];
  requested: CapabilitySurfaceResult["requested"];
  loaded: string[];
  alreadyActive: string[];
  evicted: string[];
  missing: string[];
  unavailable: CapabilitySurfaceResult["unavailable"];
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
  source: "capability_surface" | "tool_validation" | "tool_execution" | "verification";
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
  capabilitySurface?: PromptCapabilitySurfaceState;
  observations?: PromptObservations;
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
  workspaceRoot?: string;
}

export function buildAgentStateView(state: LoopState, options: AgentStateViewOptions = {}): AgentStateView {
  const progress = buildProgressView(state);
  const capabilitySurface = buildCapabilitySurfaceView(state.lastCapabilitySurface);
  const workingFeedback = buildWorkingFeedbackView(state);
  const observations = buildObservationsView(state.toolContext);
  const contextPack = buildAgentContextPack(state);
  const exactToolCalls = buildPromptToolCallsForRun(state.toolContext?.toolCalls);
  const toolCalls = exactToolCalls
    ? applyRunContextProjectionOverlay(exactToolCalls, state.runContextProjection)
    : undefined;
  const verifiedOutcomes = buildPromptVerifiedOutcomes({
    runId: state.runId,
    calls: state.toolContext?.toolCalls,
  });
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
    context: contextPack,
    tools: buildToolsContext({
      activeTools: options.activeTools,
      capabilitySurface,
    }),
    harness: buildHarnessContext({
      workingFeedback,
    }),
    run: buildRunContext({
      workspaceRoot: options.workspaceRoot,
      mode: buildVirtualModeCard(state.virtualMode, {
        workstreamBound: state.harnessContext.contextEngine?.current.routing?.status === "bound",
        routingObserved: collectWorkstreamRoutingEvidence(state).observed,
        hotContextAvailable: state.hotContext.available.length > 0,
      }),
      boundWorkstream: buildBoundWorkstreamPromptContext(
        state.harnessContext.contextEngine,
      ),
      workState: progress,
      toolCalls,
      verifiedOutcomes,
      contextPressure: buildContextPressureView(state),
    }),
  });

  return {
    context,
    ...(progress ? { progress } : {}),
    ...(workingFeedback ? { workingFeedback } : {}),
    ...(capabilitySurface ? { capabilitySurface } : {}),
    ...(observations ? { observations } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(trace ? { trace } : {}),
    ...(attachments ? { attachments } : {}),
    ...(systemEvent ? { systemEvent } : {}),
  };
}

function buildToolsContext(input: {
  activeTools?: string[];
  capabilitySurface?: PromptCapabilitySurfaceState;
}): PromptToolsContext | undefined {
  const active = [...new Set(input.activeTools ?? [])]
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (active.length === 0 && !input.capabilitySurface) {
    return undefined;
  }
  return {
    active,
    ...(input.capabilitySurface ? { lastSurface: input.capabilitySurface } : {}),
  };
}

function buildRunContext(input: {
  workspaceRoot?: string;
  mode: NonNullable<PromptRunContext["mode"]>;
  boundWorkstream?: PromptRunContext["boundWorkstream"];
  workState?: PromptProgressState;
  toolCalls?: PromptToolCalls;
  verifiedOutcomes?: PromptVerifiedOutcomes;
  contextPressure?: PromptRunContext["contextPressure"];
}): PromptRunContext {
  return {
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    mode: input.mode,
    ...(input.boundWorkstream
      ? { boundWorkstream: input.boundWorkstream }
      : {}),
    ...(input.workState ? { workState: input.workState } : {}),
    ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
    ...(input.verifiedOutcomes
      ? { verifiedOutcomes: input.verifiedOutcomes }
      : {}),
    ...(input.contextPressure ? { contextPressure: input.contextPressure } : {}),
  };
}

function buildContextPressureView(state: LoopState): PromptRunContext["contextPressure"] | undefined {
  const pressure = state.contextPressure;
  if (!pressure || pressure.mode === "full") return undefined;
  return {
    mode: pressure.mode,
    ...(pressure.recommendedMode ? { recommendedMode: pressure.recommendedMode } : {}),
    ...(pressure.escalationReason ? { escalationReason: pressure.escalationReason } : {}),
    unresolvedPressureStreak: pressure.unresolvedPressureStreak ?? 0,
    compactedCalls: pressure.latestReceipt?.transformations.filter(
      (transformation) => transformation.kind === "tool_call_projection",
    ).length ?? 0,
    ...(pressure.latestReceipt?.targetReached !== undefined
      ? { targetReached: pressure.latestReceipt.targetReached }
      : {}),
    recoverable: true,
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

  const capabilitySurfaceFeedback = buildCapabilitySurfaceWorkingFeedback(
    state.lastCapabilitySurface,
  );
  if (capabilitySurfaceFeedback) {
    latest.push(capabilitySurfaceFeedback);
  }

  for (const failure of getActiveFailures(state.failureHistory).slice(-3)) {
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
  const routing = state.harnessContext.contextEngine?.current.routing;
  if (routing?.status === "clarifying") {
    return {
      severity: "warning",
      source: "tool_validation",
      message: "The current Context Engine pending turn is clarifying. Do not call executable tools while workstream ownership is unresolved.",
      retryHint: "Ask the user directly which workstream or target they mean.",
    };
  }
  return undefined;
}

function buildCapabilitySurfaceWorkingFeedback(
  result: CapabilitySurfaceResult | undefined,
): PromptWorkingFeedbackItem | undefined {
  if (!result || ["loaded", "already_active", "not_needed"].includes(result.status)) {
    return undefined;
  }
  return {
    severity: result.status === "failed" ? "error" : "warning",
    source: "capability_surface",
    message: truncate(result.message, 360),
    retryHint: result.unavailable.some((entry) => entry.reason === "requires_workstream_binding")
      ? "Route ownership, then use decision_resolve_activate with exact observed resource IDs or decision_resolve_create with typed workspace targets."
      : result.missing.length > 0
      ? `Requested capabilities were not available: ${compactList(result.missing, 5, 80).join(", ")}. Choose an exact id from the capability catalog.`
      : "If the current capability surface is insufficient, use a bounded self-transition with different exact capability ids.",
  };
}

function isToolValidationReason(reason: string): boolean {
  return reason.includes("Invalid input for")
    || reason.includes("Tool input preflight failed")
    || reason.includes("missing required field")
    || reason.includes("No active workstream exists");
}

function buildFailureRetryHint(failureType: LoopState["failureHistory"][number]["failureType"], reason: string): string | undefined {
  if (reason.includes("No active workstream exists")) {
    return "Route ownership, then enter resolve with observed activation authority or typed workspace creation targets. Validate needs_user_input if ownership remains ambiguous.";
  }
  if (failureType === "validation_error" || isToolValidationReason(reason)) {
    return "Retry the selected executable tool with all required schema fields. Do not use an empty input object.";
  }
  if (reason.includes("Unknown tool") || reason.includes("was not selected")) {
    return "Change the current mode capability surface, then call only a selected executable tool.";
  }
  if (reason.includes("permission")) {
    return "Ask the user only if the action requires permission or an irreversible change.";
  }
  if (reason.includes("verification") || reason.includes("validate")) {
    return "Use the latest observations and evidence to correct the next concrete tool call.";
  }
  return undefined;
}

function buildCapabilitySurfaceView(
  result: CapabilitySurfaceResult | undefined,
): PromptCapabilitySurfaceState | undefined {
  if (!result) {
    return undefined;
  }
  return {
    status: result.status,
    requested: compactList(result.requested, 12, 120),
    loaded: compactList(result.loaded, 12, 120),
    alreadyActive: compactList(result.alreadyActive, 12, 120),
    evicted: compactList(result.evicted, 12, 120),
    missing: compactList(result.missing, 12, 120),
    unavailable: result.unavailable.slice(0, 12),
    message: truncate(result.message, 360),
  };
}

function buildProgressView(state: LoopState): PromptProgressState | undefined {
  const workState = state.workState;
  if (
    state.workStateRuntime.updateReason === "initial"
    && !hasMaterialWorkState(workState)
  ) {
    return undefined;
  }
  const summary = truncate(workState.summary, 500);
  const plan = workState.plan.slice(0, 12);
  const importantContext = workState.importantContext.slice(0, 12);
  const nextAction = workState.nextAction?.trim()
    ? truncate(workState.nextAction, 320)
    : undefined;

  return {
    status: workState.status,
    ...(summary.length > 0 ? { summary } : {}),
    ...(plan.length > 0 ? { plan } : {}),
    ...(importantContext.length > 0 ? { importantContext } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
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
  return getActiveFailures(state.failureHistory).slice(-3).map((failure) => ({
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
