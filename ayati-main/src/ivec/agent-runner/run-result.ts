import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
import { latestActiveFailure } from "./failure-lifecycle.js";
import { isFilesystemTaskValidationOutcomeKind } from "./task-validation-contracts.js";
import { validationModePassed } from "./validation-mode.js";
import {
  filesystemResourceAliases,
  filesystemResourceContextByPath,
  filesystemResourceDescription,
} from "./filesystem-resource-context.js";
import {
  workStateBlockers,
  workStateEvidenceRefs,
  workStateFindings,
  workStateOpenTasks,
} from "./work-state/selectors.js";

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
    currentFocus: state.workState.nextAction?.trim() || undefined,
    completedMilestones: state.harnessContext.contextEngine?.workstream?.workstreamStatus === "done"
      ? [state.harnessContext.contextEngine.workstream.summary]
      : [],
    openWork,
    blockers,
    keyFacts: normalizeList(workStateFindings(state.workState)),
    evidence: normalizeList(workStateEvidenceRefs(state.workState)),
    userInputNeeded: state.workState.status === "needs_user_input"
      ? state.workState.nextAction?.trim() || undefined
      : undefined,
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
      metadataStatus: resource.metadataStatus,
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
      metadataStatus: "enriched",
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
      metadataStatus: "enriched",
    })),
    ...buildGeneratedResources(state),
    ...buildVerifiedCompletionResources(state),
  ]);
}

export function buildVerifiedCompletionResources(state: LoopState): AgentResourceRecord[] {
  const validation = state.virtualMode.validation;
  if (
    !validationModePassed(state.virtualMode)
    || validation?.returnMode !== "execute"
  ) {
    return [];
  }

  const generatedArtifacts = generatedArtifactPaths(state);
  const writeStatuses = desiredWriteStatusByPath(state);
  const resourceContext = filesystemResourceContextByPath(state);
  const metadataByPath = new Map(
    (validation.resourceMetadata ?? []).map((metadata) => [
      absolutePath(metadata.path),
      metadata,
    ]),
  );
  const validated = validation.checks.flatMap((check) => {
    if (!isFilesystemTaskValidationOutcomeKind(check.kind)) {
      return [];
    }
    const path = absolutePath(check.subject);
    const kind = check.actualKind
      ?? (check.expectedKind && check.expectedKind !== "either"
        ? check.expectedKind
        : undefined);
    if (
      check.status !== "passed"
      || !kind
      || !validatesGeneratedArtifact(path, kind, generatedArtifacts)
    ) {
      return [];
    }
    const pathContext = resourceContext.get(path);
    const existing = existingFilesystemResource(state, path)
      ?? (
        pathContext?.sourcePath
          ? existingFilesystemResource(state, pathContext.sourcePath)
          : undefined
      );
    const writeStatus = writeStatuses.get(path);
    const resourceKind = kind === "symlink" ? "file" : kind;
    const metadata = metadataByPath.get(path);
    const displayName = metadata?.displayName
      ?? existing?.displayName
      ?? (path.split("/").pop() || path);
    const origin = pathContext?.disposition === "created"
      ? "agent_created"
      : pathContext?.disposition === "existing"
        || pathContext?.disposition === "moved"
        ? existing?.origin ?? "agent_discovered"
      : writeStatus === "created"
      ? "agent_created"
      : writeStatus
        ? existing?.origin ?? "agent_discovered"
        : "agent_created";
    return [{
      resourceId: existing?.resourceId ?? stableResourceId(path),
      role: "deliverable",
      kind: resourceKind,
      origin,
      displayName,
      description: metadata?.description
        ?? filesystemResourceDescription({
          path,
          displayName,
          kind: resourceKind,
          context: pathContext,
          existingDescription: existing?.description,
          validated: true,
        }),
      aliases: filesystemResourceAliases(
        path,
        displayName,
        [
          ...(existing?.aliases ?? []),
          ...(metadata?.aliases ?? []),
        ],
        pathContext?.sourcePath,
      ),
      locator: { kind: "filesystem", path },
      metadataStatus: metadata
        ? "enriched"
        : existing?.metadataStatus ?? "fallback",
    } satisfies AgentResourceRecord];
  });
  const directoryCounts = new Map<string, {
    count: number;
    hasCreatedChild: boolean;
    hasKnownWriteStatus: boolean;
  }>();
  for (const resource of validated) {
    if (resource.kind !== "file" || resource.locator.kind !== "filesystem") continue;
    const parent = dirname(resource.locator.path);
    const current = directoryCounts.get(parent) ?? {
      count: 0,
      hasCreatedChild: false,
      hasKnownWriteStatus: false,
    };
    const writeStatus = writeStatuses.get(resource.locator.path);
    directoryCounts.set(parent, {
      count: current.count + 1,
      hasCreatedChild: current.hasCreatedChild
        || writeStatus === "created",
      hasKnownWriteStatus: current.hasKnownWriteStatus || Boolean(writeStatus),
    });
  }
  const projectDirectories = [...directoryCounts.entries()]
    .filter(([, value]) => value.count >= 2)
    .map(([path, value]): AgentResourceRecord => {
      const existing = existingFilesystemResource(state, path);
      const metadata = metadataByPath.get(path);
      const displayName = metadata?.displayName
        ?? existing?.displayName
        ?? (path.split("/").pop() || path);
      const origin = existing?.origin
        ?? (
          value.hasCreatedChild || !value.hasKnownWriteStatus
            ? "agent_created"
            : "agent_discovered"
        );
      return {
        resourceId: existing?.resourceId ?? stableResourceId(path),
        role: "deliverable",
        kind: "directory",
        origin,
        displayName,
        description: metadata?.description
          ?? existing?.description
          ?? (origin === "agent_created"
            ? `Validated project directory ${displayName}.`
            : `Validated existing project directory ${displayName}.`),
        aliases: filesystemResourceAliases(
          path,
          displayName,
          [
            ...(existing?.aliases ?? []),
            ...(metadata?.aliases ?? []),
          ],
        ),
        locator: { kind: "filesystem", path },
        metadataStatus: metadata
          ? "enriched"
          : existing?.metadataStatus ?? "fallback",
      };
    });
  return dedupeResources([...projectDirectories, ...validated]);
}

function toWorkstreamSummaryStatus(status: WorkState["status"]): AgentWorkstreamSummaryRecord["workstreamStatus"] {
  return status === "in_progress" ? "open" : status;
}

function buildWorkstreamSummaryOpenWork(
  state: LoopState,
  workstreamStatus: AgentWorkstreamSummaryRecord["workstreamStatus"],
  failureSummary: WorkstreamSummaryFailureSummary | undefined,
): string[] {
  const openWork = normalizeList(workStateOpenTasks(state.workState));
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
  const blockers = normalizeList(workStateBlockers(state.workState));
  if (workstreamStatus !== "blocked" || blockers.length > 0) {
    return blockers;
  }
  if (failureSummary?.error) {
    return [failureSummary.error];
  }
  return ["The workstream request is blocked."];
}

function deriveNextAction(state: LoopState): string | undefined {
  if (state.workState.nextAction?.trim()) {
    return state.workState.nextAction.trim();
  }
  const openWork = workStateOpenTasks(state.workState);
  if (openWork.length > 0) {
    return openWork[0];
  }
  const blockers = workStateBlockers(state.workState);
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
  const latestFailure = latestActiveFailure(state.failureHistory);
  const error = latestFailure?.reason
    || failedStep?.evidenceSummary
    || failedStep?.summary
    || workStateBlockers(state.workState)[0]
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
  const artifacts = generatedArtifactPaths(state);
  const writeStatuses = desiredWriteStatusByPath(state);
  const resourceContext = filesystemResourceContextByPath(state);
  const resources: AgentResourceRecord[] = [];
  const directoryCounts = new Map<string, number>();

  for (const artifact of artifacts) {
    const writeStatus = writeStatuses.get(artifact);
    const pathContext = resourceContext.get(artifact);
    if (
      pathContext?.disposition === "existing"
      || (writeStatus && writeStatus !== "created")
    ) {
      continue;
    }
    const kind = inferPathAssetKind(artifact);
    const movedResource = pathContext?.sourcePath
      ? existingFilesystemResource(state, pathContext.sourcePath)
      : undefined;
    const displayName = movedResource?.displayName
      ?? (artifact.split("/").pop() || artifact);
    if (kind === "file") {
      const parent = dirname(artifact);
      directoryCounts.set(parent, (directoryCounts.get(parent) ?? 0) + 1);
    }
    resources.push({
      resourceId: movedResource?.resourceId ?? stableResourceId(artifact),
      role: "output",
      kind,
      origin: pathContext?.disposition === "moved"
        ? movedResource?.origin ?? "agent_discovered"
        : "agent_created",
      displayName,
      description: filesystemResourceDescription({
        path: artifact,
        displayName,
        kind,
        context: pathContext,
        existingDescription: movedResource?.description,
      }),
      aliases: filesystemResourceAliases(
        artifact,
        displayName,
        movedResource?.aliases,
        pathContext?.sourcePath,
      ),
      locator: { kind: "filesystem", path: artifact },
      metadataStatus: movedResource?.metadataStatus ?? "fallback",
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
      description: `Agent-created directory ${directoryPath.split("/").pop() || directoryPath}.`,
      aliases: filesystemResourceAliases(
        directoryPath,
        directoryPath.split("/").pop() || directoryPath,
      ),
      locator: { kind: "filesystem", path: directoryPath },
      metadataStatus: "fallback",
    });
  }

  return resources;
}

function generatedArtifactPaths(state: LoopState): string[] {
  return normalizeList(state.completedSteps.flatMap((step) => (
    stepHasGeneratedArtifactEvidence(step) ? step.artifacts : []
  )))
    .filter((artifact) => isDurableStepArtifact(artifact))
    .map((artifact) => absolutePath(artifact));
}

function desiredWriteStatusByPath(
  state: LoopState,
): Map<string, "created" | "replaced" | "unchanged"> {
  const statuses = new Map<string, "created" | "replaced" | "unchanged">();
  for (const call of state.toolContext?.toolCalls ?? []) {
    for (const evidence of call.completionEvidence ?? []) {
      if (
        evidence.kind !== "path_state"
        || evidence.operation !== "write"
        || !evidence.writeStatus
      ) {
        continue;
      }
      const path = absolutePath(evidence.path);
      const current = statuses.get(path);
      statuses.set(
        path,
        current === "created" ? current : evidence.writeStatus,
      );
    }
  }
  return statuses;
}

function existingFilesystemResource(
  state: LoopState,
  path: string,
): AgentResourceRecord | undefined {
  const resolvedPath = absolutePath(path);
  for (const binding of state.harnessContext?.contextEngine?.workstream?.resources ?? []) {
    const resource = binding.resource;
    if (
      resource.locator.kind !== "filesystem"
      || absolutePath(resource.locator.path) !== resolvedPath
    ) {
      continue;
    }
    return {
      resourceId: resource.resourceId,
      role: binding.role,
      kind: resource.kind,
      origin: resource.origin,
      displayName: resource.displayName,
      description: resource.description,
      aliases: resource.aliases,
      locator: resource.locator,
      metadataStatus: resource.metadataStatus,
    };
  }
  return undefined;
}

function validatesGeneratedArtifact(
  validationPath: string,
  kind: "file" | "directory" | "symlink",
  generatedArtifacts: string[],
): boolean {
  if (kind === "file" || kind === "symlink") {
    return generatedArtifacts.includes(validationPath);
  }
  return generatedArtifacts.some((artifact) => (
    artifact === validationPath || isDescendantPath(validationPath, artifact)
  ));
}

function isDescendantPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
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
    metadataStatus: "enriched",
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
