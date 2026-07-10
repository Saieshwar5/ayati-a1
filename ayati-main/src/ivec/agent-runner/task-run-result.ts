import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type { TaskAssetRecord } from "../../context-engine/index.js";
import type {
  AgentLoopResult,
  AgentTaskSummaryRecord,
  CompletionDirective,
  LoopState,
  TaskSummaryFailureSummary,
  WorkState,
} from "../types.js";
import {
  isDurableStepArtifact,
  stepHasGeneratedArtifactEvidence,
} from "./final-response-policy.js";

export function buildTaskSummaryRecord(
  state: LoopState,
  assistantResponse: string,
  runStatus: AgentLoopResult["status"],
  responseKind: AgentLoopResult["type"],
  completion?: CompletionDirective,
): AgentTaskSummaryRecord {
  const userFacingSummary = completion?.summary?.trim() || assistantResponse.trim();
  const progressSummary = state.workState.summary.trim();
  const taskStatus = toTaskSummaryTaskStatus(state.workState.status);
  const failureSummary = buildFailureSummary(state);
  const openWork = buildTaskSummaryOpenWork(state, taskStatus, failureSummary);
  const blockers = buildTaskSummaryBlockers(state, taskStatus, failureSummary);
  return {
    runId: state.runId,
    runPath: "",
    triggerSeq: state.currentSeq,
    discussionStartSeq: findDiscussionStartSeq(state),
    discussionEndSeq: state.currentSeq,
    runStatus,
    taskStatus,
    objective: state.userMessage.trim() || undefined,
    summary: userFacingSummary || progressSummary,
    progressSummary: progressSummary || undefined,
    currentFocus: state.workState.nextStep?.trim() || undefined,
    completedMilestones: normalizeList(state.harnessContext.contextEngine?.task?.completed),
    openWork,
    blockers,
    keyFacts: normalizeList(state.workState.verifiedFacts),
    evidence: normalizeList(state.workState.evidence),
    userInputNeeded: state.workState.userInputNeeded?.trim() || undefined,
    userMessage: state.userMessage.trim() || undefined,
    assistantResponse,
    assistantResponseKind: responseKind === "none" ? undefined : responseKind,
    feedbackKind: completion?.feedback_kind,
    feedbackLabel: completion?.feedback_label,
    actionType: completion?.action_type,
    entityHints: completion?.entity_hints,
    toolsUsed: normalizeList(state.completedSteps.flatMap((step) => step.toolsUsed ?? [])),
    nextAction: deriveNextAction(state),
    stopReason: deriveStopReason(state, runStatus),
    failureSummary,
    attachmentNames: buildAttachmentNames(state.preparedAttachments),
  };
}

export function buildTaskAssets(state: LoopState): TaskAssetRecord[] {
  const sessionId = readContextSessionId(state.harnessContext.contextEngine?.session);
  return dedupeTaskAssets([
    ...(state.preparedAttachmentRecords ?? []).map((record) => attachmentRecordToTaskAsset(record, sessionId)),
    ...(state.managedFiles ?? []).map((file): TaskAssetRecord => ({
      assetId: stableAssetId("file", file.fileId),
      role: "input",
      kind: "file",
      name: file.originalName,
      ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "file", file.fileId) } : {}),
      path: absolutePath(file.storagePath),
    })),
    ...(state.managedDirectories ?? []).map((directory): TaskAssetRecord => ({
      assetId: stableAssetId("directory", directory.directoryId),
      role: "input",
      kind: "directory",
      name: directory.name,
      ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "directory", directory.directoryId) } : {}),
      path: absolutePath(directory.rootPath),
    })),
    ...buildGeneratedArtifactAssets(state),
  ]);
}

function toTaskSummaryTaskStatus(status: WorkState["status"]): AgentTaskSummaryRecord["taskStatus"] {
  return status === "not_done" ? "open" : status;
}

function buildTaskSummaryOpenWork(
  state: LoopState,
  taskStatus: AgentTaskSummaryRecord["taskStatus"],
  failureSummary: TaskSummaryFailureSummary | undefined,
): string[] {
  const openWork = normalizeList(state.workState.openWork);
  if (taskStatus !== "open" || openWork.length > 0) {
    return openWork;
  }
  const nextAction = deriveNextAction(state);
  if (nextAction) {
    return [nextAction];
  }
  if (failureSummary?.suggestedRecovery) {
    return [failureSummary.suggestedRecovery];
  }
  return ["Continue the requested task."];
}

function buildTaskSummaryBlockers(
  state: LoopState,
  taskStatus: AgentTaskSummaryRecord["taskStatus"],
  failureSummary: TaskSummaryFailureSummary | undefined,
): string[] {
  const blockers = normalizeList(state.workState.blockers);
  if (taskStatus !== "blocked" || blockers.length > 0) {
    return blockers;
  }
  if (failureSummary?.error) {
    return [failureSummary.error];
  }
  return ["Task is blocked."];
}

function deriveNextAction(state: LoopState): string | undefined {
  if (state.workState.userInputNeeded?.trim()) {
    return state.workState.userInputNeeded.trim();
  }
  if (state.workState.nextStep?.trim()) {
    return state.workState.nextStep.trim();
  }
  const openWork = state.workState.openWork ?? [];
  if (openWork.length > 0) {
    return openWork[0];
  }
  const blockers = state.workState.blockers ?? [];
  if (blockers.length > 0) {
    return blockers[0];
  }
  return undefined;
}

function findDiscussionStartSeq(state: LoopState): number | undefined {
  if (!state.currentSeq) {
    return undefined;
  }
  return state.currentSeq;
}

function deriveStopReason(
  state: LoopState,
  status: AgentLoopResult["status"],
): AgentTaskSummaryRecord["stopReason"] {
  if (state.contextLimitReached) return "context_limit";
  if (state.workState.status === "needs_user_input") return "needs_user_input";
  if (state.workState.status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "stuck") return "stuck";
  return "completed";
}

function buildFailureSummary(state: LoopState): TaskSummaryFailureSummary | undefined {
  if (state.workState.status !== "blocked" && state.status !== "failed" && state.status !== "stuck") {
    return undefined;
  }
  const failedStep = [...state.completedSteps].reverse().find((step) => step.outcome === "failed");
  const latestFailure = state.failureHistory[state.failureHistory.length - 1];
  const error = latestFailure?.reason
    || failedStep?.evidenceSummary
    || failedStep?.summary
    || state.workState.blockers?.[0]
    || state.workState.summary;
  const failedTool = failedStep?.toolsUsed?.[0];
  const failureType = failedStep?.failureType ?? latestFailure?.failureType;
  const suggestedRecovery = suggestFailureRecovery(failedTool, failureType, error);
  return {
    ...(failedStep?.step ? { failedStep: failedStep.step } : {}),
    ...(failedTool ? { failedTool } : {}),
    ...(failureType ? { failureType } : {}),
    error,
    retryable: isRetryableFailure(failureType, error),
    ...(suggestedRecovery ? { suggestedRecovery } : {}),
  };
}

function isRetryableFailure(failureType: string | undefined, error: string): boolean {
  if (failureType === "permission") {
    return false;
  }
  return !/\b(destructive|irreversible|unauthorized)\b/i.test(error);
}

function suggestFailureRecovery(
  failedTool: string | undefined,
  failureType: string | undefined,
  error: string,
): string | undefined {
  if (failedTool === "directory_search" && /No managed directories are available/i.test(error)) {
    return "Restore the relevant task asset or use the absolute project path directly before searching.";
  }
  if (failureType === "missing_path") {
    return "Restore or verify the absolute path before retrying.";
  }
  if (failureType === "validation_error") {
    return "Retry with input that matches the tool schema.";
  }
  if (failureType === "tool_error") {
    return "Retry with the relevant durable asset restored and verify the target path first.";
  }
  return undefined;
}

function buildAttachmentNames(preparedAttachments: PreparedAttachmentSummary[] | undefined): string[] {
  return (preparedAttachments ?? []).map((attachment) => attachment.displayName);
}

function readContextSessionId(
  session: NonNullable<LoopState["harnessContext"]["contextEngine"]>["session"] | undefined,
): string | undefined {
  if (!session) {
    return undefined;
  }
  return session.meta?.sessionId ?? (session as unknown as { sessionId?: string }).sessionId;
}

function buildGeneratedArtifactAssets(state: LoopState): TaskAssetRecord[] {
  const artifacts = normalizeList(state.completedSteps.flatMap((step) => (
    stepHasGeneratedArtifactEvidence(step) ? step.artifacts : []
  )))
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => absolutePath(artifact));
  const assets: TaskAssetRecord[] = [];
  const directoryCounts = new Map<string, number>();

  for (const artifact of artifacts) {
    const kind = inferPathAssetKind(artifact);
    if (kind === "file") {
      const parent = dirname(artifact);
      directoryCounts.set(parent, (directoryCounts.get(parent) ?? 0) + 1);
    }
    assets.push({
      assetId: stableAssetId(kind, artifact),
      role: "generated",
      kind,
      name: artifact.split("/").pop() || artifact,
      path: artifact,
    });
  }

  for (const [directoryPath, count] of directoryCounts.entries()) {
    if (count < 2) {
      continue;
    }
    assets.push({
      assetId: stableAssetId("directory", directoryPath),
      role: "generated",
      kind: "directory",
      name: directoryPath.split("/").pop() || directoryPath,
      path: directoryPath,
    });
  }

  return assets;
}

function attachmentRecordToTaskAsset(
  record: PreparedAttachmentRecord,
  sessionId: string | undefined,
): TaskAssetRecord {
  const kind = record.summary.mode === "structured_data" ? "dataset" : "document";
  return {
    assetId: stableAssetId(kind, record.summary.documentId),
    role: "input",
    kind,
    name: record.summary.displayName,
    ...(sessionId ? { sessionAssetId: stableSessionAssetId(sessionId, "document", record.summary.documentId) } : {}),
    path: absolutePath(record.manifest.originalPath || record.summary.artifactPath),
  };
}

function dedupeTaskAssets(assets: TaskAssetRecord[]): TaskAssetRecord[] {
  const output = new Map<string, TaskAssetRecord>();
  for (const asset of assets) {
    output.set(asset.assetId, asset);
  }
  return [...output.values()];
}

function inferPathAssetKind(path: string): string {
  if (/\.(?:html|css|js|jsx|ts|tsx|json|md|txt|py|sql|csv|pdf|png|jpg|jpeg|svg)$/i.test(path)) {
    return "file";
  }
  return "directory";
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function stableAssetId(kind: string, identity: string): string {
  return `asset_${createHash("sha256").update(`${kind}:${identity}`).digest("hex").slice(0, 20)}`;
}

function stableSessionAssetId(sessionId: string, kind: string, identity: string): string {
  return `SA-${createHash("sha256").update(`${sessionId}\0${kind}\0${identity}`).digest("hex").slice(0, 16)}`;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
