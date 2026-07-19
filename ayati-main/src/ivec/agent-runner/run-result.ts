import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PreparedAttachmentRecord } from "../../documents/prepared-attachment-registry.js";
import type { PreparedAttachmentSummary } from "../../documents/types.js";
import type {
  AgentLoopResult,
  AgentResourceRecord,
  AgentWorkstreamSummaryRecord,
  CompletionDirective,
  LoopState,
  WorkstreamSummaryFailureSummary,
  WorkState,
} from "../types.js";
import {
  isDurableStepArtifact,
  stepHasGeneratedArtifactEvidence,
} from "./final-response-policy.js";

export function buildWorkstreamSummaryRecord(
  state: LoopState,
  assistantResponse: string,
  runStatus: AgentLoopResult["status"],
  responseKind: AgentLoopResult["type"],
  completion?: CompletionDirective,
): AgentWorkstreamSummaryRecord {
  const userFacingSummary = completion?.summary?.trim() || assistantResponse.trim();
  const progressSummary = state.workState.summary.trim();
  const workstreamStatus = toWorkstreamSummaryStatus(state.workState.status);
  const failureSummary = buildFailureSummary(state);
  const openWork = buildWorkstreamSummaryOpenWork(state, workstreamStatus, failureSummary);
  const blockers = buildWorkstreamSummaryBlockers(state, workstreamStatus, failureSummary);
  return {
    runId: state.runId,
    runPath: "",
    triggerSeq: state.currentSeq,
    discussionStartSeq: findDiscussionStartSeq(state),
    discussionEndSeq: state.currentSeq,
    runStatus,
    workstreamStatus,
    objective: state.userMessage.trim() || undefined,
    summary: userFacingSummary || progressSummary,
    progressSummary: progressSummary || undefined,
    currentFocus: state.workState.nextStep?.trim() || undefined,
    completedMilestones: state.harnessContext.contextEngine?.workstream?.workstreamStatus === "done"
      ? [state.harnessContext.contextEngine.workstream.summary]
      : [],
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

export function buildRunResources(state: LoopState): AgentResourceRecord[] {
  return dedupeResources([
    ...(state.harnessContext.contextEngine?.workstream?.resources ?? []).map(({ resource, role }) => ({
      resourceId: resource.resourceId,
      role,
      kind: resource.kind,
      origin: resource.origin,
      displayName: resource.displayName,
      description: resource.description,
      aliases: resource.aliases,
      locator: resource.locator,
    } satisfies AgentResourceRecord)),
    ...(state.preparedAttachmentRecords ?? []).map(attachmentRecordToResource),
    ...(state.managedFiles ?? []).map((file): AgentResourceRecord => ({
      resourceId: stableResourceId(absolutePath(file.storagePath)),
      role: "input",
      kind: "file",
      origin: "user_attachment",
      displayName: file.originalName,
      description: `User-provided file ${file.originalName}.`,
      aliases: [file.originalName, file.fileId],
      locator: { kind: "filesystem", path: absolutePath(file.storagePath) },
    })),
    ...(state.managedDirectories ?? []).map((directory): AgentResourceRecord => ({
      resourceId: stableResourceId(absolutePath(directory.rootPath)),
      role: "input",
      kind: "directory",
      origin: "user_attachment",
      displayName: directory.name,
      description: `User-provided directory ${directory.name}.`,
      aliases: [directory.name, directory.directoryId],
      locator: { kind: "filesystem", path: absolutePath(directory.rootPath) },
    })),
    ...buildGeneratedResources(state),
    ...buildVerifiedCompletionResources(state),
  ]);
}

export function buildVerifiedCompletionResources(state: LoopState): AgentResourceRecord[] {
  return (state.completionResources ?? []).map((asset) => ({
    resourceId: stableResourceId(asset.resolvedPath),
    role: "deliverable",
    kind: asset.kind,
    origin: "agent_created",
    displayName: asset.path.split("/").pop() || asset.path,
    description: asset.description,
    aliases: [asset.path.split("/").pop() || asset.path],
    locator: { kind: "filesystem", path: asset.resolvedPath },
  }));
}

function toWorkstreamSummaryStatus(status: WorkState["status"]): AgentWorkstreamSummaryRecord["workstreamStatus"] {
  return status === "not_done" ? "open" : status;
}

function buildWorkstreamSummaryOpenWork(
  state: LoopState,
  workstreamStatus: AgentWorkstreamSummaryRecord["workstreamStatus"],
  failureSummary: WorkstreamSummaryFailureSummary | undefined,
): string[] {
  const openWork = normalizeList(state.workState.openWork);
  if (workstreamStatus !== "open" || openWork.length > 0) {
    return openWork;
  }
  const nextAction = deriveNextAction(state);
  if (nextAction) {
    return [nextAction];
  }
  if (failureSummary?.suggestedRecovery) {
    return [failureSummary.suggestedRecovery];
  }
  return ["Continue the active workstream request."];
}

function buildWorkstreamSummaryBlockers(
  state: LoopState,
  workstreamStatus: AgentWorkstreamSummaryRecord["workstreamStatus"],
  failureSummary: WorkstreamSummaryFailureSummary | undefined,
): string[] {
  const blockers = normalizeList(state.workState.blockers);
  if (workstreamStatus !== "blocked" || blockers.length > 0) {
    return blockers;
  }
  if (failureSummary?.error) {
    return [failureSummary.error];
  }
  return ["The workstream request is blocked."];
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
): AgentWorkstreamSummaryRecord["stopReason"] {
  if (state.contextLimitReached) return "context_limit";
  if (state.runLimitReached) return "run_limit";
  if (state.workState.status === "needs_user_input") return "needs_user_input";
  if (state.workState.status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "stuck") return "stuck";
  return "completed";
}

function buildFailureSummary(state: LoopState): WorkstreamSummaryFailureSummary | undefined {
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
    return "Restore the relevant workstream resource or use its absolute path directly before searching.";
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

function buildGeneratedResources(state: LoopState): AgentResourceRecord[] {
  const artifacts = normalizeList(state.completedSteps.flatMap((step) => (
    stepHasGeneratedArtifactEvidence(step) ? step.artifacts : []
  )))
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => absolutePath(artifact));
  const resources: AgentResourceRecord[] = [];
  const directoryCounts = new Map<string, number>();

  for (const artifact of artifacts) {
    const kind = inferPathAssetKind(artifact);
    if (kind === "file") {
      const parent = dirname(artifact);
      directoryCounts.set(parent, (directoryCounts.get(parent) ?? 0) + 1);
    }
    resources.push({
      resourceId: stableResourceId(artifact),
      role: "output",
      kind,
      origin: "agent_created",
      displayName: artifact.split("/").pop() || artifact,
      description: completionResourceDescription(state, artifact)
        ?? `Agent-created ${kind} ${artifact.split("/").pop() || artifact}.`,
      aliases: [artifact.split("/").pop() || artifact],
      locator: { kind: "filesystem", path: artifact },
    });
  }

  for (const [directoryPath, count] of directoryCounts.entries()) {
    if (count < 2) {
      continue;
    }
    resources.push({
      resourceId: stableResourceId(directoryPath),
      role: "output",
      kind: "directory",
      origin: "agent_created",
      displayName: directoryPath.split("/").pop() || directoryPath,
      description: completionResourceDescription(state, directoryPath)
        ?? `Agent-created directory ${directoryPath.split("/").pop() || directoryPath}.`,
      aliases: [directoryPath.split("/").pop() || directoryPath],
      locator: { kind: "filesystem", path: directoryPath },
    });
  }

  return resources;
}

function completionResourceDescription(
  state: LoopState,
  path: string,
): string | undefined {
  const asset = state.completionResources?.find((candidate) => candidate.resolvedPath === path);
  return asset?.description;
}

function attachmentRecordToResource(
  record: PreparedAttachmentRecord,
): AgentResourceRecord {
  const kind = record.summary.mode === "structured_data" ? "dataset" : "document";
  const path = absolutePath(record.manifest.originalPath || record.summary.artifactPath);
  return {
    resourceId: stableResourceId(path),
    role: "input",
    kind,
    origin: "user_attachment",
    displayName: record.summary.displayName,
    description: `User-provided ${kind} ${record.summary.displayName}.`,
    aliases: [record.summary.displayName, record.summary.documentId],
    locator: { kind: "filesystem", path },
  };
}

function dedupeResources(resources: AgentResourceRecord[]): AgentResourceRecord[] {
  const output = new Map<string, AgentResourceRecord>();
  for (const resource of resources) {
    output.set(resource.resourceId, resource);
  }
  return [...output.values()];
}

function inferPathAssetKind(path: string): "file" | "directory" {
  if (/\.(?:html|css|js|jsx|ts|tsx|json|md|txt|py|sql|csv|pdf|png|jpg|jpeg|svg)$/i.test(path)) {
    return "file";
  }
  return "directory";
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function stableResourceId(path: string): string {
  return `RES-${createHash("sha256").update(`filesystem:${resolve(path)}`).digest("hex").slice(0, 24).toUpperCase()}`;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}
