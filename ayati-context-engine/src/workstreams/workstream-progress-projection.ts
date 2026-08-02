import type {
  ResourceEvent,
  ResourceEventType,
  RunOutcome,
  WorkstreamCompletionProof,
  WorkstreamCompletionRecord,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import type { RunWorkState } from "../run-work-state-contracts.js";
import {
  renderWorkstreamProgressEntry,
  WORKSTREAM_PROGRESS_LIMITS,
  type WorkstreamProgressEntry,
} from "./workstream-progress.js";

export interface BuildWorkstreamProgressEntryInput {
  runId: string;
  requestId: string;
  at: string;
  outcome: RunOutcome;
  summary: string;
  validation: "passed" | "failed" | "not_applicable";
  workState: RunWorkState;
  completion: WorkstreamCompletionRecord;
  resourceEvents: readonly ResourceEvent[];
  next?: string;
}

const MUTATION_EVENT_TYPES = new Set<ResourceEventType>([
  "created",
  "modified",
  "moved",
  "deleted",
  "restored",
  "downloaded",
  "external_state_changed",
]);

export function buildWorkstreamProgressEntry(
  input: BuildWorkstreamProgressEntryInput,
): WorkstreamProgressEntry {
  requireMatchingSources(input);
  const entry: WorkstreamProgressEntry = {
    runId: input.runId,
    requestId: input.requestId,
    at: input.at,
    outcome: input.outcome,
    summary: progressSummary(input),
    workCompleted: completedWork(input.workState, input.resourceEvents),
    verifiedMutations: verifiedMutations(input.resourceEvents),
    validation: validationItems(input.validation, input.completion),
    findingsAndDecisions: durableContext(input.workState),
    problems: progressProblems(input.workState, input.completion),
    ...progressNext(input),
  };
  // Reject an invalid projection before it reaches repository finalization.
  renderWorkstreamProgressEntry(entry);
  return entry;
}

function requireMatchingSources(input: BuildWorkstreamProgressEntryInput): void {
  if (input.workState.runId !== input.runId) {
    throw invalid("Progress WorkState does not belong to the finalized run.", {
      runId: input.runId,
      workStateRunId: input.workState.runId,
    });
  }
  for (const event of input.resourceEvents) {
    if (event.runId !== input.runId) {
      throw invalid("Progress resource event does not belong to the finalized run.", {
        runId: input.runId,
        eventId: event.eventId,
        eventRunId: event.runId,
      });
    }
    if (event.requestId && event.requestId !== input.requestId) {
      throw invalid("Progress resource event does not belong to the bound request.", {
        requestId: input.requestId,
        eventId: event.eventId,
        eventRequestId: event.requestId,
      });
    }
  }
  for (const criterion of input.completion.criteria) {
    for (const proof of criterion.proofs ?? []) {
      const expectedPrefix = `run:${input.runId}:step:${proof.source.step}:`;
      if (!proof.outcomeRef.startsWith(expectedPrefix)) {
        throw invalid("Progress completion proof does not belong to the finalized run and step.", {
          runId: input.runId,
          criterion: criterion.criterion,
          outcomeRef: proof.outcomeRef,
          sourceStep: proof.source.step,
        });
      }
    }
  }
}

function progressSummary(input: BuildWorkstreamProgressEntryInput): string {
  return compactText(
    input.workState.summary,
    WORKSTREAM_PROGRESS_LIMITS.summaryChars,
  ) || compactText(input.summary, WORKSTREAM_PROGRESS_LIMITS.summaryChars);
}

function completedWork(
  workState: RunWorkState,
  events: readonly ResourceEvent[],
): string[] {
  const completedPlanItems = uniqueItems(workState.plan
    .filter((item) => item.status === "done")
    .map((item) => progressItem(item.task))
    .filter(Boolean));
  if (completedPlanItems.length > 0) return completedPlanItems;
  return uniqueItems([...events]
    .filter((event) => MUTATION_EVENT_TYPES.has(event.type))
    .sort(compareResourceEvents)
    .map((event) => progressItem(event.summary)));
}

function verifiedMutations(events: readonly ResourceEvent[]): string[] {
  return uniqueItems([...events]
    .filter((event) => MUTATION_EVENT_TYPES.has(event.type))
    .sort(compareResourceEvents)
    .map((event) => {
      const subject = mutationLabel(event.type) + " `" + event.resourceId + "`";
      const summary = compactText(event.summary, WORKSTREAM_PROGRESS_LIMITS.itemChars);
      return progressItem(summary ? subject + ": " + summary : subject + ".");
    }));
}

function validationItems(
  validation: BuildWorkstreamProgressEntryInput["validation"],
  completion: WorkstreamCompletionRecord,
): string[] {
  const result = [
    validation === "passed"
      ? "Overall validation passed."
      : validation === "failed"
        ? "Overall validation failed."
        : "Overall validation was not applicable.",
    completion.accepted
      ? "Completion evidence was accepted."
      : "Completion evidence was not accepted.",
  ];
  for (const criterion of completion.criteria) {
    const criterionText = compactText(
      criterion.criterion,
      Math.floor(WORKSTREAM_PROGRESS_LIMITS.itemChars / 2),
    );
    if (!criterionText) continue;
    const prefix = (criterion.passed ? "Criterion passed: " : "Criterion not passed: ")
      + criterionText;
    if ((criterion.proofs?.length ?? 0) > 0) {
      result.push(prefix + renderProofRefs(
        criterion.proofs ?? [],
        WORKSTREAM_PROGRESS_LIMITS.itemChars - prefix.length,
      ));
      continue;
    }
    const legacyEvidence = compactText(
      criterion.evidence ?? "",
      Math.max(0, WORKSTREAM_PROGRESS_LIMITS.itemChars - prefix.length - 11),
    );
    result.push(progressItem(
      prefix + (legacyEvidence ? " Evidence: " + legacyEvidence : ""),
    ));
  }
  return uniqueItems(result);
}

function renderProofRefs(
  proofs: readonly WorkstreamCompletionProof[],
  maximumChars: number,
): string {
  const label = " Proof refs: ";
  if (maximumChars <= label.length) return "";
  const selected: string[] = [];
  for (let index = 0; index < proofs.length; index += 1) {
    const candidate = [...selected, proofs[index]!.outcomeRef].join("; ");
    const remaining = proofs.length - index - 1;
    const marker = remaining > 0 ? `; +${remaining} more` : "";
    if ((label + candidate + marker).length > maximumChars) break;
    selected.push(proofs[index]!.outcomeRef);
  }
  if (selected.length === 0) {
    return compactText(" Structured proof recorded.", maximumChars);
  }
  const remaining = proofs.length - selected.length;
  return label + selected.join("; ") + (remaining > 0 ? `; +${remaining} more` : "");
}

function durableContext(workState: RunWorkState): string[] {
  return uniqueItems(workState.importantContext.flatMap((item) => {
    if (item.kind !== "decision" && item.kind !== "finding") return [];
    const value = compactText(item.value, WORKSTREAM_PROGRESS_LIMITS.itemChars);
    return value
      ? [progressItem((item.kind === "decision" ? "Decision: " : "Finding: ") + value)]
      : [];
  }));
}

function progressProblems(
  workState: RunWorkState,
  completion: WorkstreamCompletionRecord,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string): void => {
    const normalized = compactText(value, WORKSTREAM_PROGRESS_LIMITS.itemChars);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(progressItem(label + normalized));
  };
  for (const missing of completion.missing) add("Missing: ", missing);
  for (const failure of completion.failures) add("Failure: ", failure);
  for (const item of workState.plan) {
    if (item.status === "blocked") add("Blocked: ", item.task);
  }
  return uniqueItems(result);
}

function progressNext(
  input: BuildWorkstreamProgressEntryInput,
): { next?: string } {
  const next = compactText(
    input.next ?? "",
    WORKSTREAM_PROGRESS_LIMITS.nextChars,
  ) || compactText(
    input.workState.nextAction ?? "",
    WORKSTREAM_PROGRESS_LIMITS.nextChars,
  );
  return next ? { next } : {};
}

function compareResourceEvents(left: ResourceEvent, right: ResourceEvent): number {
  return compareText(left.at, right.at) || compareText(left.eventId, right.eventId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mutationLabel(type: ResourceEventType): string {
  if (type === "created") return "Created";
  if (type === "modified") return "Modified";
  if (type === "moved") return "Moved";
  if (type === "deleted") return "Deleted";
  if (type === "restored") return "Restored";
  if (type === "downloaded") return "Downloaded";
  if (type === "external_state_changed") return "Changed external state for";
  throw invalid("Progress mutation classification contains a non-mutation event.", {
    eventType: type,
  });
}

function uniqueItems(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function progressItem(value: string): string {
  return compactText(value, WORKSTREAM_PROGRESS_LIMITS.itemChars);
}

function compactText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  return normalized.slice(0, Math.max(0, maximum - 3)).trimEnd() + "...";
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_PROGRESS_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
