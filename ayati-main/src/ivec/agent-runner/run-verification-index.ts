import { isAbsolute, relative, resolve } from "node:path";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import {
  isObservationalTool,
  isRoutingTool,
} from "../../skills/tool-taxonomy.js";
import type {
  FilesystemCompletionEvidence,
  RunToolCallContext,
} from "../types.js";
import { isWorkstreamRoutingObservationTool } from "./workstream-routing-evidence.js";
import {
  normalizeFileSearchValidationScope,
  registeredArtifactOutcome,
  registeredTaskOutcomeFromFact,
  routingFactCanSatisfyTaskValidation,
} from "./task-validation-outcome-registry.js";
import { verifiedReadScopeFromEvidence } from "./run-verification-read-scope.js";
import type {
  CurrentRunVerificationIndex,
  RunInvalidatedOutcome,
  RunVerificationCallReceipt,
  RunVerificationExcludedCall,
  RunVerificationSource,
  RunVerifiedFactOutcome,
  RunVerifiedFileSearchOutcome,
  RunVerifiedOutcome,
  RunVerifiedOutcomeRole,
  RunVerifiedPathOutcome,
  RunVerifiedPathOutcomeKind,
  RunVerifiedTaskOutcome,
  RunVerifiedToolDenialOutcome,
} from "./run-verification-index-contracts.js";

export type {
  CurrentRunVerificationIndex,
  RunInvalidatedOutcome,
  RunVerificationCallReceipt,
  RunVerificationSource,
  RunVerifiedFileReadOutcome,
  RunVerifiedFileSearchOutcome,
  RunVerifiedOutcome,
  RunVerifiedPathOutcome,
  RunVerifiedTaskOutcome,
  RunVerifiedToolDenialOutcome,
} from "./run-verification-index-contracts.js";
export {
  findCurrentCompletionOutcomeByRef,
  findInvalidatedCompletionOutcomeByRef,
  findLatestInvalidatedCompleteRead,
  findLatestInvalidatedOutcomeForCheck,
  findLatestInvalidatedPathOutcome,
  findLatestVerifiedCompleteRead,
  findLatestVerifiedOutcomeForCheck,
  findLatestVerifiedPathOutcome,
} from "./run-verification-index-queries.js";

interface OrderedCall {
  call: RunToolCallContext;
  inputOrder: number;
}

const PRE_EXECUTION_PERMISSION_DENIAL_CODES = new Set([
  "PATH_OUTSIDE_MUTATION_WORKSPACE",
  "PATH_OUTSIDE_RESOURCE_SCOPE",
  "PATH_OUTSIDE_WORKSPACE_ROOT",
  "WORKSTREAM_RESOURCE_MUTATION_DENIED",
  "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
  "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
]);

export function buildCurrentRunVerificationIndex(input: {
  runId: string;
  calls?: RunToolCallContext[];
}): CurrentRunVerificationIndex {
  const runId = input.runId.trim();
  if (!runId) {
    throw new Error("Current-run verification index requires a run id.");
  }

  const calls: RunVerificationCallReceipt[] = [];
  const outcomes: RunVerifiedOutcome[] = [];
  const excluded: RunVerificationExcludedCall[] = [];
  let ordinal = 0;
  let throughStep = 0;

  for (const { call } of orderedCalls(input.calls)) {
    const exclusion = validateCurrentRunReference(runId, call);
    if (exclusion) {
      excluded.push(exclusion);
      continue;
    }

    throughStep = Math.max(throughStep, call.step);
    const source = buildSource(runId, call);
    const scope = isRoutingOnlyCall(call.tool) ? "routing" : "task";
    const receipt = buildCallReceipt(call, source, scope);
    calls.push(receipt);
    if (receipt.status !== "passed") {
      const denial = toolDenialOutcome(call, source, scope, ordinal);
      if (denial) {
        outcomes.push(denial);
        ordinal++;
      }
      continue;
    }

    const role: RunVerifiedOutcomeRole = scope === "routing"
      ? "routing"
      : "completion";
    const completionCountBefore = outcomes.filter(
      (outcome) => outcome.role === "completion",
    ).length;
    for (const evidence of call.completionEvidence ?? []) {
      if (!evidenceBelongsToCall(evidence, call)) continue;
      const outcome = completionOutcome(evidence, source, role, ordinal++);
      if (outcome) outcomes.push(outcome);
    }
    for (const artifact of call.artifacts ?? []) {
      const registered = registeredArtifactOutcome(artifact);
      if (!registered) continue;
      outcomes.push(taskOutcome({
        source,
        role,
        ordinal: ordinal++,
        registered,
        artifactKind: artifact.kind,
      }));
    }
    for (const [factIndex, fact] of (call.verification?.facts ?? []).entries()) {
      const registered = registeredTaskOutcomeFromFact(fact);
      if (
        registered
        && (
          scope === "task"
          || routingFactCanSatisfyTaskValidation(call.tool, fact)
        )
      ) {
        outcomes.push(taskOutcome({
          source,
          role: "completion",
          ordinal: ordinal++,
          registered,
        }));
      }
      outcomes.push(verifiedFactOutcome({
        source,
        role: scope === "routing" ? "routing" : "supporting",
        ordinal: ordinal++,
        factIndex,
        fact,
      }));
    }
    const completionCountAfter = outcomes.filter(
      (outcome) => outcome.role === "completion",
    ).length;
    if (
      scope === "task"
      && completionCountAfter === completionCountBefore
      && receipt.method === "runtime_check"
    ) {
      outcomes.push(callSucceededOutcome(source, ordinal++));
    }
  }

  const { current, invalidated } = invalidateStaleFilesystemOutcomes(outcomes);
  return {
    version: 1,
    runId,
    throughStep,
    calls,
    outcomes: current,
    invalidated,
    excluded,
    summary: summarize(calls, current, invalidated, excluded),
  };
}

function orderedCalls(calls: RunToolCallContext[] | undefined): OrderedCall[] {
  return (calls ?? [])
    .filter((call) => call.stepKind !== "transient_context")
    .map((call, inputOrder) => ({ call, inputOrder }))
    .sort((a, b) => a.call.step - b.call.step || a.inputOrder - b.inputOrder);
}

function validateCurrentRunReference(
  runId: string,
  call: RunToolCallContext,
): RunVerificationExcludedCall | undefined {
  const ref = call.stepRef;
  if (!ref) return undefined;
  if (ref.runId !== runId) {
    return {
      step: call.step,
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      reason: "different_run",
      referencedRunId: ref.runId,
    };
  }
  if (
    ref.step !== call.step
    || (ref.callId !== undefined && ref.callId !== call.callId)
  ) {
    return {
      step: call.step,
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      reason: "invalid_step_reference",
      referencedRunId: ref.runId,
    };
  }
  return undefined;
}

function buildSource(
  runId: string,
  call: RunToolCallContext,
): RunVerificationSource {
  return {
    runId,
    step: call.step,
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    ref: [
      `run:${runId}`,
      `step:${call.step}`,
      ...(call.callId ? [`call:${call.callId}`] : []),
    ].join(":"),
    ...(call.evidenceRef ? { evidenceRef: call.evidenceRef } : {}),
  };
}

function buildCallReceipt(
  call: RunToolCallContext,
  source: RunVerificationSource,
  scope: RunVerificationCallReceipt["scope"],
): RunVerificationCallReceipt {
  const status = callVerificationStatus(call);
  const summary = call.verification?.summary
    ?? call.error
    ?? (status === "passed"
      ? `${call.tool} passed deterministic verification.`
      : status === "failed"
        ? `${call.tool} failed deterministic verification.`
        : `${call.tool} has no deterministic verification result.`);
  const code = call.verification?.failure?.code ?? call.code;
  return {
    source,
    scope,
    status,
    ...(call.verification?.method
      ? { method: call.verification.method }
      : call.verificationPassed !== undefined
        ? { method: "legacy" as const }
        : {}),
    summary,
    ...(code ? { code } : {}),
    ...(call.errorCategory ? { errorCategory: call.errorCategory } : {}),
    ...(call.errorTarget ? { errorTarget: call.errorTarget } : {}),
  };
}

function callVerificationStatus(
  call: RunToolCallContext,
): RunVerificationCallReceipt["status"] {
  if (
    call.status === "failed"
    || call.operationStatus === "failed"
    || call.operationStatus === "partial"
  ) {
    return "failed";
  }
  if (call.verification) {
    return call.verification.status;
  }
  if (call.verificationPassed === true) return "passed";
  if (call.verificationPassed === false) return "failed";
  return "not_available";
}

function completionOutcome(
  evidence: FilesystemCompletionEvidence,
  source: RunVerificationSource,
  role: RunVerifiedOutcomeRole,
  ordinal: number,
): RunVerifiedOutcome | undefined {
  if (evidence.kind === "file_search") {
    return fileSearchOutcome(evidence, source, role, ordinal);
  }
  if (evidence.kind === "file_search_match") {
    return fileSearchMatchOutcome(evidence, source, role, ordinal);
  }
  if (evidence.kind === "file_search_count") {
    return fileSearchCountOutcome(evidence, source, role, ordinal);
  }
  const subject = normalizeAbsolutePath(evidence.path);
  if (!isAbsolute(subject)) return undefined;
  if (evidence.kind === "file_read") {
    const kind = evidence.coverage === "complete" && evidence.contentAvailable
      ? "file.read_complete"
      : "file.read_partial";
    const readScope = verifiedReadScopeFromEvidence(evidence);
    const outcomeRole = role === "routing"
      ? "routing"
      : kind === "file.read_complete" || readScope
        ? "completion"
        : "supporting";
    return {
      id: `${source.ref}:outcome:${ordinal}`,
      ordinal,
      family: "filesystem_read",
      kind,
      role: outcomeRole,
      subject,
      summary: readOutcomeSummary(subject, kind, readScope),
      source,
      requestedPath: evidence.requestedPath,
      coverage: evidence.coverage,
      contentAvailable: evidence.contentAvailable,
      ...(evidence.mode ? { mode: evidence.mode } : {}),
      ...(evidence.truncated !== undefined
        ? { truncated: evidence.truncated }
        : {}),
      ...(evidence.lineCountKnown !== undefined
        ? { lineCountKnown: evidence.lineCountKnown }
        : {}),
      ...(readScope ? { readScope } : {}),
      ...(evidence.matchCount !== undefined
        ? { matchCount: evidence.matchCount }
        : {}),
      ...(evidence.sizeBytes !== undefined ? { sizeBytes: evidence.sizeBytes } : {}),
      ...(evidence.lineCount !== undefined ? { lineCount: evidence.lineCount } : {}),
      ...(evidence.sha256 ? { sha256: evidence.sha256 } : {}),
    };
  }

  const kind = pathOutcomeKind(evidence);
  return {
    id: `${source.ref}:outcome:${ordinal}`,
    ordinal,
    family: "filesystem_path",
    kind,
    role,
    subject,
    summary: pathOutcomeSummary(
      kind,
      subject,
      evidence.modeOctal,
      evidence.modeSymbolic,
    ),
    source,
    exists: evidence.exists,
    ...(evidence.actualKind ? { actualKind: evidence.actualKind } : {}),
    change: evidence.change,
    operation: evidence.operation,
    ...(evidence.requestedPath ? { requestedPath: evidence.requestedPath } : {}),
    ...(evidence.modeOctal ? { modeOctal: evidence.modeOctal } : {}),
    ...(evidence.modeSymbolic ? { modeSymbolic: evidence.modeSymbolic } : {}),
  };
}

function fileSearchOutcome(
  evidence: Extract<FilesystemCompletionEvidence, { kind: "file_search" }>,
  source: RunVerificationSource,
  role: RunVerifiedOutcomeRole,
  ordinal: number,
): RunVerifiedFileSearchOutcome | undefined {
  if (
    !evidence.complete
    || evidence.matchCount !== 0
    || evidence.capped
    || evidence.errorCount !== 0
    || evidence.depthLimitedDirectoryCount !== 0
  ) {
    return undefined;
  }
  const subject = evidence.query.trim();
  if (!subject) return undefined;
  return {
    id: `${source.ref}:outcome:${ordinal}`,
    ordinal,
    family: "filesystem_search",
    kind: "file.search_no_match",
    role,
    subject,
    summary: `Found no ${searchEntryLabel(evidence.entryKind)} matches for "${subject}" in the verified search scope.`,
    source,
    searchScope: normalizeFileSearchValidationScope({
      roots: evidence.roots,
      maxDepth: evidence.maxDepth,
      includeHidden: evidence.includeHidden,
      entryKind: evidence.entryKind,
    }),
    matchCount: 0,
    capped: false,
    errorCount: 0,
    depthLimitedDirectoryCount: 0,
    complete: true,
  };
}

function searchEntryLabel(kind: "file" | "directory" | "symlink" | "any"): string {
  if (kind === "file") return "file-name";
  if (kind === "directory") return "directory-name";
  if (kind === "symlink") return "symbolic-link-name";
  return "file-directory-or-symbolic-link-name";
}

function fileSearchMatchOutcome(
  evidence: Extract<FilesystemCompletionEvidence, { kind: "file_search_match" }>,
  source: RunVerificationSource,
  role: RunVerifiedOutcomeRole,
  ordinal: number,
): RunVerifiedFileSearchOutcome | undefined {
  const subject = normalizeAbsolutePath(evidence.path);
  const query = evidence.query.trim();
  if (!isAbsolute(subject) || !query || evidence.line < 1) return undefined;
  return {
    id: `${source.ref}:outcome:${ordinal}`,
    ordinal,
    family: "filesystem_search",
    kind: "file.search_match",
    role,
    subject,
    summary: `Found a verified content match for "${query}" in ${subject} at line ${evidence.line}.`,
    source,
    actualKind: "file",
    searchMatch: {
      query,
      line: evidence.line,
      caseSensitive: evidence.caseSensitive,
    },
  };
}

function fileSearchCountOutcome(
  evidence: Extract<FilesystemCompletionEvidence, { kind: "file_search_count" }>,
  source: RunVerificationSource,
  role: RunVerifiedOutcomeRole,
  ordinal: number,
): RunVerifiedFileSearchOutcome | undefined {
  const query = evidence.query.trim();
  if (!query || !evidence.countComplete || evidence.hasMore) return undefined;
  return {
    id: `${source.ref}:outcome:${ordinal}`,
    ordinal,
    family: "filesystem_search",
    kind: "file.search_count",
    role,
    subject: query,
    summary: `Counted exactly ${evidence.totalMatchCount} occurrence${evidence.totalMatchCount === 1 ? "" : "s"} of "${query}" in the verified search scope.`,
    source,
    searchCount: {
      query,
      roots: [...new Set(evidence.roots)].sort(),
      maxDepth: evidence.maxDepth,
      includeHidden: evidence.includeHidden,
      caseSensitive: evidence.caseSensitive,
      countUnit: "occurrences",
      totalMatchCount: evidence.totalMatchCount,
    },
  };
}

function readOutcomeSummary(
  subject: string,
  kind: "file.read_complete" | "file.read_partial",
  readScope: ReturnType<typeof verifiedReadScopeFromEvidence>,
): string {
  if (kind === "file.read_complete") {
    return `Completely read ${subject}.`;
  }
  if (readScope?.mode === "slice") {
    return `Read the verified line scope ${readScope.startLine}-${readScope.endLine} from ${subject}.`;
  }
  if (readScope?.mode === "search") {
    return `Searched ${subject} for the verified query "${readScope.query}".`;
  }
  if (readScope?.mode === "profile") {
    return `Read a verified profile of ${subject}.`;
  }
  return `Partially read ${subject}.`;
}

function taskOutcome(input: {
  source: RunVerificationSource;
  role: RunVerifiedOutcomeRole;
  ordinal: number;
  registered: ReturnType<typeof registeredTaskOutcomeFromFact> extends infer T
    ? Exclude<T, undefined>
    : never;
  artifactKind?: string;
}): RunVerifiedTaskOutcome {
  return {
    id: `${input.source.ref}:task:${input.ordinal}`,
    ordinal: input.ordinal,
    family: "task",
    kind: input.registered.kind,
    role: input.role,
    subject: input.registered.subject,
    summary: input.registered.summary,
    source: input.source,
    ...(input.registered.factKind
      ? { factKind: input.registered.factKind }
      : {}),
    ...(input.artifactKind ? { artifactKind: input.artifactKind } : {}),
    ...(input.registered.data ? { data: input.registered.data } : {}),
  };
}

function callSucceededOutcome(
  source: RunVerificationSource,
  ordinal: number,
): RunVerifiedTaskOutcome {
  const subject = source.callId ?? `step:${source.step}:${source.tool}`;
  return {
    id: `${source.ref}:task:${ordinal}`,
    ordinal,
    family: "task",
    kind: "tool.call_succeeded",
    role: "completion",
    subject,
    summary: `${source.tool} passed deterministic verification.`,
    source,
  };
}

function toolDenialOutcome(
  call: RunToolCallContext,
  source: RunVerificationSource,
  scope: RunVerificationCallReceipt["scope"],
  ordinal: number,
): RunVerifiedToolDenialOutcome | undefined {
  const denialCode = call.code?.trim()
    || call.verification?.failure?.code.trim();
  if (
    scope !== "task"
    || call.status !== "failed"
    || call.operationStatus !== "failed"
    || call.errorCategory !== "permission"
    || !call.callId?.trim()
    || !denialCode
    || (
      !isObservationalTool(call.tool)
      && !PRE_EXECUTION_PERMISSION_DENIAL_CODES.has(denialCode)
    )
  ) {
    return undefined;
  }
  return {
    id: `${source.ref}:denial:${ordinal}`,
    ordinal,
    family: "tool_denial",
    kind: "tool.call_denied",
    role: "completion",
    subject: call.callId,
    summary: `${call.tool} was deterministically denied with ${denialCode}.`,
    source,
    denialCode,
    tool: call.tool,
    ...(call.errorTarget ? { target: call.errorTarget } : {}),
  };
}

function verifiedFactOutcome(input: {
  source: RunVerificationSource;
  role: RunVerifiedOutcomeRole;
  ordinal: number;
  factIndex: number;
  fact: NonNullable<RunToolCallContext["verification"]>["facts"][number];
}): RunVerifiedFactOutcome {
  return {
    id: `${input.source.ref}:fact:${input.factIndex}`,
    ordinal: input.ordinal,
    family: "verified_fact",
    kind: "tool.verified_fact",
    role: input.role,
    ...(input.fact.subject ? { subject: input.fact.subject } : {}),
    summary: input.fact.message,
    source: input.source,
    factKind: input.fact.kind,
    message: input.fact.message,
    ...(input.fact.data ? { data: input.fact.data } : {}),
  };
}

function pathOutcomeKind(
  evidence: Extract<FilesystemCompletionEvidence, { kind: "path_state" }>,
): RunVerifiedPathOutcomeKind {
  if (evidence.operation === "write") {
    return evidence.writeStatus === "unchanged" ? "path.exists" : "file.written";
  }
  if (evidence.operation === "patch") return "file.patched";
  if (evidence.operation === "copy") return "path.copied";
  if (evidence.operation === "permissions") return "file.permissions_set";
  if (evidence.operation === "create") return "directory.created";
  if (evidence.operation === "move") {
    return evidence.exists ? "path.moved_to" : "path.moved_from";
  }
  if (evidence.operation === "delete") return "path.deleted";
  return evidence.exists ? "path.exists" : "path.missing";
}

function pathOutcomeSummary(
  kind: RunVerifiedPathOutcomeKind,
  subject: string,
  modeOctal?: string,
  modeSymbolic?: string,
): string {
  switch (kind) {
    case "file.written": return `Wrote ${subject}.`;
    case "file.patched": return `Patched ${subject}.`;
    case "path.copied": return `Copied the path to ${subject}.`;
    case "file.permissions_set": return `Set file permissions on ${subject}.`;
    case "directory.created": return `Created directory ${subject}.`;
    case "path.moved_from": return `Moved the prior path from ${subject}.`;
    case "path.moved_to": return `Moved the path to ${subject}.`;
    case "path.deleted": return `Deleted ${subject}.`;
    case "path.missing": return `Confirmed ${subject} is missing.`;
    default: return modeOctal && modeSymbolic
      ? `Confirmed ${subject} exists with Unix permissions ${modeOctal} (${modeSymbolic}).`
      : `Confirmed ${subject} exists.`;
  }
}

function evidenceBelongsToCall(
  evidence: FilesystemCompletionEvidence,
  call: RunToolCallContext,
): boolean {
  return evidence.step === call.step
    && (evidence.callId === undefined || evidence.callId === call.callId);
}

function invalidateStaleFilesystemOutcomes(
  outcomes: RunVerifiedOutcome[],
): {
  current: RunVerifiedOutcome[];
  invalidated: RunInvalidatedOutcome[];
} {
  const mutations = outcomes.filter((outcome): outcome is RunVerifiedPathOutcome => (
    outcome.family === "filesystem_path"
    && outcome.role === "completion"
    && outcome.change === "mutated"
  ));
  const current: RunVerifiedOutcome[] = [];
  const invalidated: RunInvalidatedOutcome[] = [];

  for (const outcome of outcomes) {
    if (
      outcome.role !== "completion"
      || (
        outcome.family !== "filesystem_path"
        && outcome.family !== "filesystem_read"
        && outcome.family !== "filesystem_search"
      )
    ) {
      current.push(outcome);
      continue;
    }
    const mutation = mutations.find((candidate) => (
      candidate.ordinal > outcome.ordinal
      && (
        outcome.family === "filesystem_search"
          && (
            outcome.kind === "file.search_no_match"
            || outcome.kind === "file.search_count"
          )
          ? mutationInvalidatesSearch(candidate, outcome)
          : mutationInvalidatesPath(candidate, outcome.subject)
      )
    ));
    if (!mutation) {
      current.push(outcome);
      continue;
    }
    invalidated.push({
      outcome,
      reason: outcome.family === "filesystem_search"
        && (
          outcome.kind === "file.search_no_match"
          || outcome.kind === "file.search_count"
        )
        ? mutationRemovesSearchRoot(mutation, outcome)
          ? "ancestor_removed"
          : "later_mutation"
        : mutation.subject === outcome.subject
          ? "later_mutation"
          : "ancestor_removed",
      invalidatedBy: mutation.source,
    });
  }
  return { current, invalidated };
}

function mutationInvalidatesSearch(
  mutation: RunVerifiedPathOutcome,
  outcome: Extract<
    RunVerifiedFileSearchOutcome,
    { kind: "file.search_no_match" | "file.search_count" }
  >,
): boolean {
  return searchOutcomeRoots(outcome).some((root) => (
    pathIsWithin(root, mutation.subject)
    || (
      !mutation.exists
      && pathIsWithin(mutation.subject, root)
    )
  ));
}

function mutationRemovesSearchRoot(
  mutation: RunVerifiedPathOutcome,
  outcome: Extract<
    RunVerifiedFileSearchOutcome,
    { kind: "file.search_no_match" | "file.search_count" }
  >,
): boolean {
  return !mutation.exists
    && searchOutcomeRoots(outcome).some((root) => pathIsWithin(mutation.subject, root));
}

function searchOutcomeRoots(
  outcome: Extract<
    RunVerifiedFileSearchOutcome,
    { kind: "file.search_no_match" | "file.search_count" }
  >,
): string[] {
  return outcome.kind === "file.search_count"
    ? outcome.searchCount.roots
    : outcome.searchScope.roots;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === ""
    || (
      child !== ".."
      && !child.startsWith("../")
      && !child.startsWith("..\\")
      && !isAbsolute(child)
    );
}

function mutationInvalidatesPath(
  mutation: RunVerifiedPathOutcome,
  subject: string,
): boolean {
  if (mutation.subject === subject) return true;
  if (
    mutation.exists
    || (mutation.operation !== "delete" && mutation.operation !== "move")
  ) {
    return false;
  }
  const child = relative(mutation.subject, subject);
  return child !== ""
    && child !== ".."
    && !child.startsWith("../")
    && !child.startsWith("..\\")
    && !isAbsolute(child);
}

function summarize(
  calls: RunVerificationCallReceipt[],
  outcomes: RunVerifiedOutcome[],
  invalidated: RunInvalidatedOutcome[],
  excluded: RunVerificationExcludedCall[],
): CurrentRunVerificationIndex["summary"] {
  return {
    totalCalls: calls.length,
    passedCalls: calls.filter((call) => call.status === "passed").length,
    failedCalls: calls.filter((call) => call.status === "failed").length,
    notAvailableCalls: calls.filter((call) => call.status === "not_available").length,
    currentOutcomes: outcomes.length,
    completionOutcomes: outcomes.filter((outcome) => outcome.role === "completion").length,
    supportingOutcomes: outcomes.filter((outcome) => outcome.role === "supporting").length,
    routingOutcomes: outcomes.filter((outcome) => outcome.role === "routing").length,
    invalidatedOutcomes: invalidated.length,
    excludedCalls: excluded.length,
  };
}

function isRoutingOnlyCall(tool: string): boolean {
  return isWorkstreamRoutingObservationTool(tool) || isRoutingTool(tool);
}

function normalizeAbsolutePath(value: string): string {
  const required = requireAbsoluteFilesystemPath(value);
  return required.ok ? resolve(required.absolutePath) : value.trim();
}
