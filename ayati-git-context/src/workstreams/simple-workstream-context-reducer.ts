import type {
  RunOutcome,
  RunWorkState,
  WorkstreamCompletionRecord,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { RUN_FINALIZATION_LIMITS } from "../run-finalization-limits.js";
import { renderWorkstreamCard, type WorkstreamCard } from "./workstream-card.js";
import {
  requestPath,
  WORKSTREAM_CARD_PATH,
} from "./workstream-repository-layout.js";
import {
  renderWorkstreamRequest,
  validateWorkstreamRequestTransition,
  type WorkstreamRequest,
} from "./workstream-request.js";

export interface SimpleWorkstreamContextWrite {
  path: string;
  content: string;
}

export interface SimpleWorkstreamContextPlan {
  commitRequired: boolean;
  workstreamCard: WorkstreamCard;
  workstreamRequest: WorkstreamRequest;
  contextWrites: SimpleWorkstreamContextWrite[];
}

export function reduceSimpleWorkstreamContext(input: {
  workstreamCard: WorkstreamCard;
  workstreamRequest: WorkstreamRequest;
  workState: RunWorkState;
  outcome: RunOutcome;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: WorkstreamCompletionRecord;
  hasVerifiedChanges: boolean;
}): SimpleWorkstreamContextPlan {
  if (input.workstreamCard.currentRequest !== input.workstreamRequest.id
    || input.workstreamRequest.status !== "active") {
    throw invalid("Finalization requires the workstream card's active request.", {
      currentRequest: input.workstreamCard.currentRequest,
      requestId: input.workstreamRequest.id,
      requestStatus: input.workstreamRequest.status,
    });
  }
  const summary = bounded(
    input.workState.summary || input.summary,
    "workstream summary",
    RUN_FINALIZATION_LIMITS.summaryChars,
  );
  const next = optionalBounded(
    input.next ?? input.workState.nextStep,
    "next action",
    RUN_FINALIZATION_LIMITS.nextChars,
  );
  const workstreamCard: WorkstreamCard = {
    ...structuredClone(input.workstreamCard),
    currentSnapshot: summary,
  };
  let workstreamRequest = structuredClone(input.workstreamRequest);

  switch (input.outcome) {
    case "done":
      requireVerifiedCompletion(input);
      validateWorkstreamRequestTransition({ from: workstreamRequest.status, to: "done" });
      workstreamRequest.status = "done";
      workstreamRequest.outcome = summary;
      workstreamCard.currentRequest = null;
      workstreamCard.currentFocus = next ?? "Choose or create the next request.";
      workstreamCard.blockers = [];
      break;
    case "blocked":
    case "needs_user_input": {
      validateWorkstreamRequestTransition({ from: workstreamRequest.status, to: "blocked" });
      const blockers = unique([
        ...input.workState.blockers,
        ...input.completion.failures,
        ...input.workState.userInputNeeded,
      ]);
      if (blockers.length === 0) {
        throw invalid("Blocked finalization requires a concrete blocker.");
      }
      workstreamRequest.status = "blocked";
      workstreamRequest.outcome = compactDerived(
        "Blocked: " + blockers.join("; "),
        RUN_FINALIZATION_LIMITS.summaryChars,
      );
      workstreamCard.currentRequest = null;
      workstreamCard.currentFocus = next ?? "Resolve the blocker for " + workstreamRequest.id + ".";
      workstreamCard.blockers = blockers;
      break;
    }
    case "incomplete":
      workstreamRequest.outcome = compactDerived(
        "In progress: " + summary,
        RUN_FINALIZATION_LIMITS.summaryChars,
      );
      workstreamCard.currentFocus = next ?? input.workstreamCard.currentFocus;
      workstreamCard.blockers = unique(input.workState.blockers);
      break;
    case "failed":
      if (!input.hasVerifiedChanges) {
        return {
          commitRequired: false,
          workstreamCard: structuredClone(input.workstreamCard),
          workstreamRequest: structuredClone(input.workstreamRequest),
          contextWrites: [],
        };
      }
      workstreamRequest.outcome = compactDerived(
        "Latest run failed: " + summary,
        RUN_FINALIZATION_LIMITS.summaryChars,
      );
      workstreamCard.currentFocus = next ?? "Review the failed run and continue the active request.";
      workstreamCard.blockers = unique(input.workState.blockers);
      break;
  }

  const proposedWrites = [
    { path: WORKSTREAM_CARD_PATH, content: renderWorkstreamCard(workstreamCard) },
    {
      path: requestPath(workstreamRequest.id, workstreamRequest.title),
      content: renderWorkstreamRequest(workstreamRequest),
    },
  ];
  const currentContent = new Map([
    [WORKSTREAM_CARD_PATH, renderWorkstreamCard(input.workstreamCard)],
    [requestPath(input.workstreamRequest.id, input.workstreamRequest.title), renderWorkstreamRequest(input.workstreamRequest)],
  ]);
  const contextWrites = proposedWrites
    .filter((write) => currentContent.get(write.path) !== write.content)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    commitRequired: contextWrites.length > 0,
    workstreamCard,
    workstreamRequest,
    contextWrites,
  };
}

function requireVerifiedCompletion(input: {
  validation: "passed" | "failed" | "not_applicable";
  completion: WorkstreamCompletionRecord;
}): void {
  const completion = input.completion;
  if (input.validation !== "passed"
    || !completion.accepted
    || completion.missing.length > 0
    || completion.failures.length > 0
    || completion.criteria.length === 0
    || completion.criteria.some((criterion) => !criterion.passed)
    || completion.resources.some((resource) => !resource.verified)) {
    throw invalid("Completed finalization requires fully verified completion evidence.");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .map((value) => bounded(
      value,
      "workstream context item",
      RUN_FINALIZATION_LIMITS.workState.contextItemChars,
    ))
    .slice(0, RUN_FINALIZATION_LIMITS.workstreamContext.maximumBlockers);
}

function compactDerived(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maximum) return normalized;
  return normalized.slice(0, Math.max(0, maximum - 3)).trimEnd() + "...";
}

function optionalBounded(
  value: string | null | undefined,
  field: string,
  maximum: number,
): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? bounded(normalized, field, maximum) : undefined;
}

function bounded(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw invalid("Finalization field must not be empty.", {
      field,
      maximum,
      actualLength: 0,
    });
  }
  if (normalized.length > maximum) {
    throw invalid("Finalization field exceeds its declared limit.", {
      field,
      maximum,
      actualLength: normalized.length,
    });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
