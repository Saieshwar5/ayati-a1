import type {
  ResourceEvent,
  ResourceEventType,
  RunOutcome,
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
    workCompleted: completedWork(input.workState),
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
}

function progressSummary(input: BuildWorkstreamProgressEntryInput): string {
  return compactText(
    input.workState.summary,
    WORKSTREAM_PROGRESS_LIMITS.summaryChars,
  ) || compactText(input.summary, WORKSTREAM_PROGRESS_LIMITS.summaryChars);
}

function completedWork(workState: RunWorkState): string[] {
  return uniqueItems(workState.plan
    .filter((item) => item.status === "done")
    .map((item) => progressItem(item.task))
    .filter(Boolean));
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
      WORKSTREAM_PROGRESS_LIMITS.itemChars,
    );
    if (!criterionText) continue;
    const evidence = compactText(
      criterion.evidence ?? "",
      WORKSTREAM_PROGRESS_LIMITS.itemChars,
    );
    result.push(progressItem(
      (criterion.passed ? "Criterion passed: " : "Criterion not passed: ")
        + criterionText
        + (evidence ? " Evidence: " + evidence : ""),
    ));
  }
  return uniqueItems(result);
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
