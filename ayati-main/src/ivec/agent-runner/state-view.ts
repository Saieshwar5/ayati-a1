import type { LoopState, ToolContextState, ToolObservation, WorkEvidenceRef, WorkState } from "../types.js";
import { buildAgentContextPack } from "./context-pack.js";
import type { AgentContextPack } from "./context-pack.js";

export interface PromptProgressState {
  status: WorkState["status"];
  summary?: string;
  openWork?: string[];
  blockers?: string[];
  verifiedFacts?: string[];
  evidence?: string[];
  evidenceRefs?: WorkEvidenceRef[];
  nextStep?: string;
  userInputNeeded?: string;
}

export interface PromptObservations {
  latest: ToolObservation[];
}

export interface PromptTraceStep {
  step: number;
  mode?: "single" | "sequential" | "parallel" | "autonomous";
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
  reason: string;
  blockedTargets: string[];
}

export interface PromptTrace {
  recentSteps?: PromptTraceStep[];
  recentFailures?: PromptTraceFailure[];
}

export interface AgentStateView {
  context: AgentContextPack;
  progress?: PromptProgressState;
  observations?: PromptObservations;
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

export function buildAgentStateView(state: LoopState): AgentStateView {
  const progress = buildProgressView(state.workState);
  const observations = buildObservationsView(state.toolContext);
  const trace = buildTraceView(state);
  const attachments = buildAttachmentState(state);

  return {
    context: buildAgentContextPack(state),
    ...(progress ? { progress } : {}),
    ...(observations ? { observations } : {}),
    ...(trace ? { trace } : {}),
    ...(attachments ? { attachments } : {}),
    ...(state.systemEvent ? {
      systemEvent: {
        source: state.systemEvent.source,
        eventName: state.systemEvent.eventName,
        summary: state.systemEvent.summary,
        requestedAction: state.systemEventRequestedAction,
        approvalRequired: state.approvalRequired,
        approvalState: state.approvalState,
      },
    } : {}),
  };
}

function buildProgressView(workState: WorkState): PromptProgressState | undefined {
  const summary = truncate(workState.summary, 500);
  const openWork = compactList(workState.openWork, 5, 180);
  const blockers = compactList(workState.blockers, 4, 180);
  const verifiedFacts = compactList(workState.verifiedFacts, 6, 180);
  const evidence = compactList(workState.evidence, 5, 180);
  const evidenceRefs = (workState.evidenceRefs ?? []).slice(-5);
  const nextStep = workState.nextStep?.trim() ? truncate(workState.nextStep, 220) : undefined;
  const userInputNeeded = workState.userInputNeeded?.trim() ? truncate(workState.userInputNeeded, 220) : undefined;
  const hasUsefulState = workState.status !== "not_done"
    || summary.length > 0
    || openWork.length > 0
    || blockers.length > 0
    || verifiedFacts.length > 0
    || evidence.length > 0
    || evidenceRefs.length > 0
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
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(userInputNeeded ? { userInputNeeded } : {}),
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
  return state.failureHistory.slice(-3).map((failure) => ({
    step: failure.step,
    failureType: failure.failureType,
    reason: truncate(failure.reason, 300),
    blockedTargets: failure.blockedTargets,
  }));
}

function readActionMode(executionContract: string | undefined): PromptTraceStep["mode"] | undefined {
  const mode = executionContract?.match(/^(single|sequential|parallel|autonomous) action:/)?.[1];
  if (mode === "single" || mode === "sequential" || mode === "parallel" || mode === "autonomous") {
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
