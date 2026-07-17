import type {
  RunWorkState,
  TaskCompletionRecord,
  TaskRunOutcome,
} from "../contracts.js";
import { GitContextServiceError } from "../errors.js";
import { renderTaskCard, type TaskCard } from "./task-card.js";
import {
  normalizePortableTaskPath,
  requestPath,
  TASK_CARD_PATH,
} from "./task-repository-layout.js";
import {
  renderTaskRequest,
  validateTaskRequestTransition,
  type TaskRequest,
} from "./task-request.js";

export interface SimpleTaskContextWrite {
  path: string;
  content: string;
}

export interface SimpleTaskContextPlan {
  commitRequired: boolean;
  taskCard: TaskCard;
  taskRequest: TaskRequest;
  contextWrites: SimpleTaskContextWrite[];
}

export function reduceSimpleTaskContext(input: {
  taskCard: TaskCard;
  taskRequest: TaskRequest;
  workState: RunWorkState;
  outcome: TaskRunOutcome;
  validation: "passed" | "failed" | "not_run";
  summary: string;
  next?: string;
  completion: TaskCompletionRecord;
  hasVerifiedChanges: boolean;
}): SimpleTaskContextPlan {
  if (input.taskCard.currentRequest !== input.taskRequest.id
    || input.taskRequest.status !== "active") {
    throw invalid("V1 finalization requires the task card's active request.", {
      currentRequest: input.taskCard.currentRequest,
      requestId: input.taskRequest.id,
      requestStatus: input.taskRequest.status,
    });
  }
  const summary = bounded(
    input.workState.summary || input.summary,
    "task summary",
    2_000,
  );
  const next = optionalBounded(input.next ?? input.workState.nextStep, "next action", 1_000);
  const taskCard: TaskCard = {
    ...structuredClone(input.taskCard),
    currentSnapshot: summary,
    importantPaths: mergeImportantPaths(input.taskCard, input.completion),
  };
  let taskRequest = structuredClone(input.taskRequest);

  switch (input.outcome) {
    case "done":
      requireVerifiedCompletion(input);
      validateTaskRequestTransition({ from: taskRequest.status, to: "done" });
      taskRequest.status = "done";
      taskRequest.outcome = summary;
      taskCard.currentRequest = null;
      taskCard.currentFocus = next ?? "Choose or create the next request.";
      taskCard.blockers = [];
      break;
    case "blocked":
    case "needs_user_input": {
      validateTaskRequestTransition({ from: taskRequest.status, to: "blocked" });
      const blockers = unique([
        ...input.workState.blockers,
        ...input.completion.failures,
        ...input.workState.userInputNeeded,
      ]);
      if (blockers.length === 0) {
        throw invalid("Blocked V1 finalization requires a concrete blocker.");
      }
      taskRequest.status = "blocked";
      taskRequest.outcome = bounded("Blocked: " + blockers.join("; "), "request outcome", 2_000);
      taskCard.currentRequest = null;
      taskCard.currentFocus = next ?? "Resolve the blocker for " + taskRequest.id + ".";
      taskCard.blockers = blockers;
      break;
    }
    case "incomplete":
      taskRequest.outcome = bounded("In progress: " + summary, "request outcome", 2_000);
      taskCard.currentFocus = next ?? input.taskCard.currentFocus;
      taskCard.blockers = unique(input.workState.blockers);
      break;
    case "failed":
      if (!input.hasVerifiedChanges) {
        return {
          commitRequired: false,
          taskCard: structuredClone(input.taskCard),
          taskRequest: structuredClone(input.taskRequest),
          contextWrites: [],
        };
      }
      taskRequest.outcome = bounded("Latest run failed: " + summary, "request outcome", 2_000);
      taskCard.currentFocus = next ?? "Review the failed run and continue the active request.";
      taskCard.blockers = unique(input.workState.blockers);
      break;
  }

  const proposedWrites = [
    { path: TASK_CARD_PATH, content: renderTaskCard(taskCard) },
    {
      path: requestPath(taskRequest.id, taskRequest.title),
      content: renderTaskRequest(taskRequest),
    },
  ];
  const currentContent = new Map([
    [TASK_CARD_PATH, renderTaskCard(input.taskCard)],
    [requestPath(input.taskRequest.id, input.taskRequest.title), renderTaskRequest(input.taskRequest)],
  ]);
  const contextWrites = proposedWrites
    .filter((write) => currentContent.get(write.path) !== write.content)
    .sort((left, right) => left.path.localeCompare(right.path));
  return { commitRequired: true, taskCard, taskRequest, contextWrites };
}

function requireVerifiedCompletion(input: {
  validation: "passed" | "failed" | "not_run";
  completion: TaskCompletionRecord;
}): void {
  const completion = input.completion;
  if (input.validation !== "passed"
    || !completion.accepted
    || completion.missing.length > 0
    || completion.failures.length > 0
    || completion.criteria.length === 0
    || completion.criteria.some((criterion) => !criterion.passed)
    || completion.assets.some((asset) => !asset.verified)) {
    throw invalid("Completed V1 finalization requires fully verified completion evidence.");
  }
}

function mergeImportantPaths(
  taskCard: TaskCard,
  completion: TaskCompletionRecord,
): TaskCard["importantPaths"] {
  const paths = new Map(taskCard.importantPaths.map((entry) => [entry.path, { ...entry }]));
  for (const asset of completion.assets) {
    if (!asset.verified) continue;
    const path = normalizePortableTaskPath(asset.path);
    paths.set(path, {
      path,
      description: bounded(asset.description, "asset description", 500),
    });
  }
  const result = [...paths.values()].sort((left, right) => left.path.localeCompare(right.path));
  if (result.length > 20) {
    throw invalid("V1 finalization would exceed the task card's important-path limit.", {
      count: result.length,
    });
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .map((value) => bounded(value, "task context item", 500));
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
    throw invalid("V1 finalization field is empty or exceeds its limit.", {
      field,
      maximum,
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
