import type {
  RunOutcome,
  RunWorkState,
  WorkstreamCompletionRecord,
  WorkstreamRequestLifecycleEffect,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { RUN_FINALIZATION_LIMITS } from "../run-finalization-limits.js";
import { renderWorkstreamCard, type WorkstreamCard } from "./workstream-card.js";
import { planWorkstreamRequestChange } from "./workstream-request-lifecycle.js";
import {
  WORKSTREAM_CARD_PATH,
} from "./workstream-repository-layout.js";
import {
  renderWorkstreamRequest,
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
  expectedHead: string;
  workstreamCard: WorkstreamCard;
  workstreamRequest: WorkstreamRequest;
  workState: RunWorkState;
  outcome: RunOutcome;
  validation: "passed" | "failed" | "not_applicable";
  summary: string;
  next?: string;
  completion: WorkstreamCompletionRecord;
  requestEffect: WorkstreamRequestLifecycleEffect;
  hasVerifiedChanges: boolean;
  at: string;
}): SimpleWorkstreamContextPlan {
  const selectedIsActive = input.workstreamCard.currentRequest === input.workstreamRequest.id
    && input.workstreamRequest.status === "active";
  if (!selectedIsActive && input.requestEffect.kind !== "none") {
    throw invalid("A lifecycle effect requires the workstream's active request.", {
      currentRequest: input.workstreamCard.currentRequest,
      requestId: input.workstreamRequest.id,
      requestStatus: input.workstreamRequest.status,
    });
  }
  if (input.workstreamRequest.status === "done"
    || input.workstreamRequest.status === "dropped") {
    throw invalid("A finalized run cannot bind to a terminal request.");
  }
  const summary = bounded(
    input.workState.summary || input.summary,
    "workstream summary",
    RUN_FINALIZATION_LIMITS.summaryChars,
  );
  const next = optionalBounded(
    input.next ?? input.workState.nextAction,
    "next action",
    RUN_FINALIZATION_LIMITS.nextChars,
  );
  const beforeCard = structuredClone(input.workstreamCard);
  const beforeRequest = structuredClone(input.workstreamRequest);
  const hasDurableContext = input.hasVerifiedChanges
    || input.workState.importantContext.some(
      (item) => item.kind === "finding" || item.kind === "decision",
    );
  let card = input.outcome === "failed" && !hasDurableContext
    ? structuredClone(beforeCard)
    : distillCurrentContext(beforeCard, input.workState, summary, next);
  let request = beforeRequest;

  switch (input.requestEffect.kind) {
    case "none":
      break;
    case "complete": {
      if (input.outcome !== "done") {
        throw invalid("Only a successfully completed run can complete its request.");
      }
      requireVerifiedCompletion(input, input.requestEffect.verification);
      const plan = planWorkstreamRequestChange({
        expectedHead: input.expectedHead,
        workstreamCard: card,
        requests: [request],
      }, {
        kind: "complete",
        requestId: request.id,
        outcome: summary,
        verification: input.requestEffect.verification,
        at: input.at,
      });
      card = plan.workstreamCardAfter;
      request = requireChangedRequest(plan.changedRequests, request.id);
      break;
    }
    case "block": {
      if (input.outcome !== "blocked" && input.outcome !== "needs_user_input") {
        throw invalid("A request can be blocked only by a blocked run outcome.");
      }
      const plan = planWorkstreamRequestChange({
        expectedHead: input.expectedHead,
        workstreamCard: card,
        requests: [request],
      }, {
        kind: "block",
        requestId: request.id,
        reason: input.requestEffect.reason,
        at: input.at,
      });
      card = plan.workstreamCardAfter;
      request = requireChangedRequest(plan.changedRequests, request.id);
      break;
    }
    case "drop": {
      const plan = planWorkstreamRequestChange({
        expectedHead: input.expectedHead,
        workstreamCard: card,
        requests: [request],
      }, {
        kind: "drop",
        requestId: request.id,
        reason: input.requestEffect.reason,
        at: input.at,
      });
      card = plan.workstreamCardAfter;
      request = requireChangedRequest(plan.changedRequests, request.id);
      break;
    }
  }

  const proposed = new Map<string, string>([
    [WORKSTREAM_CARD_PATH, renderWorkstreamCard(card)],
    [request.relativePath, renderWorkstreamRequest(request)],
  ]);
  const current = new Map<string, string>([
    [WORKSTREAM_CARD_PATH, renderWorkstreamCard(beforeCard)],
    [beforeRequest.relativePath, renderWorkstreamRequest(beforeRequest)],
  ]);
  const contextWrites = [...proposed]
    .filter(([path, content]) => current.get(path) !== content)
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    commitRequired: contextWrites.length > 0,
    workstreamCard: card,
    workstreamRequest: request,
    contextWrites,
  };
}

function distillCurrentContext(
  input: WorkstreamCard,
  workState: RunWorkState,
  summary: string,
  next: string | undefined,
): WorkstreamCard {
  const card = structuredClone(input);
  card.currentSnapshot = summary;
  card.importantFindings = boundedUnique([
    ...card.importantFindings,
    ...workState.importantContext
      .filter((item) => item.kind === "finding")
      .map((item) => item.value),
  ]);
  card.decisions = boundedUnique([
    ...card.decisions,
    ...workState.importantContext
      .filter((item) => item.kind === "decision")
      .map((item) => item.value),
  ]);
  if (next) {
    card.currentFocus = next;
    card.nextAction = next;
  }
  return card;
}

function requireVerifiedCompletion(
  input: {
    validation: "passed" | "failed" | "not_applicable";
    completion: WorkstreamCompletionRecord;
    workstreamRequest: WorkstreamRequest;
  },
  verification: "verified" | "user_accepted",
): void {
  const completion = input.completion;
  const passedCriteria = new Set(completion.criteria
    .filter((criterion) => criterion.passed)
    .map((criterion) => normalizeCriterion(criterion.criterion)));
  const missingCriteria = input.workstreamRequest.acceptance.filter(
    (criterion) => !passedCriteria.has(normalizeCriterion(criterion)),
  );
  const evidenceComplete = completion.accepted
    && completion.missing.length === 0
    && completion.failures.length === 0
    && completion.criteria.length > 0
    && completion.criteria.every((criterion) => criterion.passed)
    && missingCriteria.length === 0
    && completion.resources.every((resource) => resource.verified);
  if (!evidenceComplete
    || (verification === "verified" && input.validation !== "passed")) {
    throw invalid("Request completion requires evidence for every acceptance criterion.", {
      missingCriteria,
    });
  }
}

function normalizeCriterion(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function requireChangedRequest(
  requests: WorkstreamRequest[],
  requestId: string,
): WorkstreamRequest {
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) throw invalid("Lifecycle plan did not return the bound request.");
  return request;
}

function boundedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => bounded(
    value,
    "workstream context item",
    RUN_FINALIZATION_LIMITS.workState.importantContextValueChars,
  )))].slice(-RUN_FINALIZATION_LIMITS.workstreamContext.maximumBlockers);
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
  if (!normalized || normalized.length > maximum) {
    throw invalid("Finalization field is empty or exceeds its declared limit.", {
      field,
      maximum,
      actualLength: normalized.length,
    });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
