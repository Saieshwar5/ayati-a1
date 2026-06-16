import type { LoopState, ToolContextState, ToolObservation, WorkEvidenceRef, WorkState } from "../types.js";
import { buildAgentContextPack } from "./context-pack.js";
import type { AgentContextPack } from "./context-pack.js";

export interface PromptWorkState {
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

export interface AgentStateView {
  context: AgentContextPack;
  workState?: PromptWorkState;
  toolContext?: ToolContextState;
  latestObservation?: ToolObservation;
  lastActions?: Array<{
    step: number;
    status: "success" | "failed";
    summary: string;
    toolsUsed: string[];
    evidence?: string[];
    artifacts?: string[];
    failureType?: string;
    blockedTargets?: string[];
  }>;
  recentFailures?: Array<{
    step: number;
    failureType: string;
    reason: string;
    blockedTargets: string[];
  }>;
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
  const workState = buildPromptWorkState(state.workState);
  const lastActions = buildLastActions(state);
  const attachments = buildAttachmentState(state);
  const toolContext = buildPromptToolContext(state.toolContext);
  const latestObservation = buildPromptObservation(state.latestObservation);

  return {
    context: buildAgentContextPack(state),
    ...(workState ? { workState } : {}),
    ...(toolContext ? { toolContext } : {}),
    ...(latestObservation ? { latestObservation } : {}),
    ...(lastActions.length > 0 ? { lastActions } : {}),
    ...(state.failureHistory.length > 0 ? {
      recentFailures: state.failureHistory.slice(-3).map((failure) => ({
        step: failure.step,
        failureType: failure.failureType,
        reason: truncate(failure.reason, 300),
        blockedTargets: failure.blockedTargets,
      })),
    } : {}),
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

function buildPromptWorkState(workState: WorkState): PromptWorkState | undefined {
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

function buildPromptObservation(observation: ToolObservation | undefined): ToolObservation | undefined {
  if (!observation) {
    return undefined;
  }
  return {
    ...observation,
    content: truncatePreserveLines(observation.content, 8_000),
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

function buildPromptToolContext(toolContext: ToolContextState | undefined): ToolContextState | undefined {
  const recent = buildPromptObservations(toolContext?.recent);
  return recent.length > 0 ? { recent } : undefined;
}

function buildLastActions(state: LoopState): NonNullable<AgentStateView["lastActions"]> {
  return state.completedSteps.slice(-2).map((step) => {
    const blockedTargets = step.blockedTargets ?? [];
    return {
      step: step.step,
      status: step.outcome === "success" ? "success" : "failed",
      summary: truncate(step.summary, 360),
      toolsUsed: step.toolsUsed ?? [],
      ...((step.evidenceItems ?? []).length > 0 ? { evidence: compactList(step.evidenceItems, 3, 180) } : {}),
      ...(step.artifacts.length > 0 ? { artifacts: compactList(step.artifacts, 4, 180) } : {}),
      ...(step.failureType ? { failureType: step.failureType } : {}),
      ...(blockedTargets.length > 0 ? { blockedTargets: blockedTargets.slice(0, 4) } : {}),
    };
  });
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
