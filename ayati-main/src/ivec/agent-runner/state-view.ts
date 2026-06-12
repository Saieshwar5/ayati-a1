import type { LoopState } from "../types.js";
import { buildAgentContextPack } from "./context-pack.js";
import type { AgentContextPack } from "./context-pack.js";

export interface AgentStateView {
  runId: string;
  inputKind: LoopState["inputKind"];
  userMessage: string;
  context: AgentContextPack;
  goal: {
    objective: string;
    doneWhen: string[];
    requiredEvidence: string[];
  };
  progress: {
    status: LoopState["taskProgress"]["status"];
    summary: string;
    currentFocus?: string;
    completedMilestones: string[];
    openWork: string[];
    blockers: string[];
    keyFacts: string[];
    evidence: string[];
    userInputNeeded?: string;
  };
  recentSteps: Array<{
    step: number;
    outcome: string;
    contract?: string;
    summary: string;
    toolsUsed: string[];
    evidence: string[];
    failureType?: string;
    blockedTargets: string[];
  }>;
  recentFailures: Array<{
    step: number;
    failureType: string;
    reason: string;
    blockedTargets: string[];
  }>;
  attachments: {
    incoming: Array<{ id: string; name: string; kind: string; source: string; mimeType?: string; status: string }>;
    prepared: Array<{ id: string; name: string; mode: string; status: string }>;
    managedFiles: Array<{ id: string; name: string; kind: string; status: string }>;
    managedDirectories: Array<{ id: string; name: string; rootPath: string; status: string }>;
    warnings: string[];
  };
  systemEvent?: {
    source?: string;
    eventName?: string;
    summary?: string;
    requestedAction?: string;
    approvalRequired?: boolean;
    approvalState?: string;
  };
  runPath: string;
}

export function buildAgentStateView(state: LoopState): AgentStateView {
  return {
    runId: state.runId,
    inputKind: state.inputKind,
    userMessage: state.userMessage,
    context: buildAgentContextPack(state),
    goal: {
      objective: state.goal.objective,
      doneWhen: state.goal.done_when,
      requiredEvidence: state.goal.required_evidence,
    },
    progress: {
      status: state.taskProgress.status,
      summary: state.taskProgress.progressSummary,
      ...(state.taskProgress.currentFocus?.trim() ? { currentFocus: state.taskProgress.currentFocus } : {}),
      completedMilestones: state.taskProgress.completedMilestones ?? [],
      openWork: state.taskProgress.openWork ?? [],
      blockers: state.taskProgress.blockers ?? [],
      keyFacts: state.taskProgress.keyFacts,
      evidence: state.taskProgress.evidence,
      ...(state.taskProgress.userInputNeeded?.trim() ? { userInputNeeded: state.taskProgress.userInputNeeded } : {}),
    },
    recentSteps: state.completedSteps.slice(-5).map((step) => ({
      step: step.step,
      outcome: step.outcome,
      ...(step.executionContract?.trim() ? { contract: step.executionContract } : {}),
      summary: truncate(step.summary, 500),
      toolsUsed: step.toolsUsed ?? [],
      evidence: (step.evidenceItems ?? []).slice(0, 5),
      ...(step.failureType ? { failureType: step.failureType } : {}),
      blockedTargets: step.blockedTargets ?? [],
    })),
    recentFailures: state.failureHistory.slice(-3).map((failure) => ({
      step: failure.step,
      failureType: failure.failureType,
      reason: truncate(failure.reason, 300),
      blockedTargets: failure.blockedTargets,
    })),
    attachments: {
      incoming: (state.attachedDocuments ?? []).slice(0, 8).map((document) => ({
        id: document.documentId,
        name: document.displayName,
        kind: document.kind,
        source: document.source,
        ...(document.mimeType?.trim() ? { mimeType: document.mimeType } : {}),
        status: "registered",
      })),
      prepared: (state.preparedAttachments ?? []).slice(0, 8).map((attachment) => ({
        id: attachment.preparedInputId,
        name: attachment.displayName,
        mode: attachment.mode,
        status: attachment.status,
      })),
      managedFiles: (state.managedFiles ?? []).slice(0, 8).map((file) => ({
        id: file.fileId,
        name: file.originalName,
        kind: file.kind,
        status: file.processingStatus,
      })),
      managedDirectories: (state.managedDirectories ?? []).slice(0, 5).map((directory) => ({
        id: directory.directoryId,
        name: directory.name,
        rootPath: directory.rootPath,
        status: directory.status,
      })),
      warnings: state.attachmentWarnings ?? [],
    },
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
    runPath: state.runPath,
  };
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
