import { GitContextServiceError } from "../errors.js";
import { isRequestId, isTaskId } from "./task-repository-layout.js";
import {
  listTaskRequests,
  type TaskRequestLifecycleState,
} from "./task-request-lifecycle.js";
import type { TaskRequest } from "./task-request.js";

export type TaskRequestRoutingDecision =
  | {
      kind: "continue_active_request";
      taskId: string;
      requestId: string;
      reason: string;
    }
  | {
      kind: "create_active_request" | "create_queued_request";
      taskId: string;
      reason: string;
    }
  | { kind: "use_different_task"; taskId: string; reason: string }
  | { kind: "create_new_task"; reason: string }
  | { kind: "read_only"; reason: string; taskId?: string }
  | { kind: "clarify"; reason: string; question: string };

export interface TaskRequestRoutingEvidence {
  /** Exact task identity explicitly supplied by the user or a trusted caller. */
  explicitTaskId?: string;
  /** Task identities proven to own named files, directories, or resources. */
  resourceOwnerTaskIds?: string[];
}

export interface TaskRequestRoutingState {
  tasks: TaskRequestLifecycleState[];
  evidence?: TaskRequestRoutingEvidence;
}

export type TaskRequestRoutingNext =
  | "continue_request"
  | "create_active_request"
  | "create_queued_request"
  | "select_task"
  | "create_task"
  | "answer_read_only"
  | "ask_clarification"
  | "transition_task_lifecycle";

export type TaskRequestMutationReadiness =
  | "ready"
  | "request_decision_required"
  | "task_creation_required"
  | "lifecycle_transition_required"
  | "not_requested";

export interface TaskRequestRoutingResolution {
  status: "ready" | "clarification_required" | "lifecycle_transition_required";
  decision: TaskRequestRoutingDecision;
  next: TaskRequestRoutingNext;
  mutationReadiness: TaskRequestMutationReadiness;
  taskId?: string;
  requestId?: string;
  candidateTaskIds?: string[];
  taskStatus?: "active" | "paused" | "archived";
  recommendedDecision?: TaskRequestRoutingDecision["kind"];
}

export function validateTaskRequestRoutingDecision(
  decision: TaskRequestRoutingDecision,
): TaskRequestRoutingDecision {
  const reason = boundedLine(decision.reason, "reason", 500);
  switch (decision.kind) {
    case "continue_active_request":
      return {
        kind: decision.kind,
        taskId: taskId(decision.taskId),
        requestId: requestId(decision.requestId),
        reason,
      };
    case "create_active_request":
    case "create_queued_request":
    case "use_different_task":
      return {
        kind: decision.kind,
        taskId: taskId(decision.taskId),
        reason,
      };
    case "create_new_task":
      return { kind: decision.kind, reason };
    case "read_only":
      return {
        kind: decision.kind,
        reason,
        ...(decision.taskId ? { taskId: taskId(decision.taskId) } : {}),
      };
    case "clarify":
      return {
        kind: decision.kind,
        reason,
        question: boundedLine(decision.question, "question", 500),
      };
    default:
      return invalid("Request routing decision kind is not supported.");
  }
}

/**
 * Resolves an explicit routing decision against durable task/request state.
 * Natural-language classification remains outside this pure policy boundary.
 */
export function resolveTaskRequestRoutingDecision(
  state: TaskRequestRoutingState,
  decision: TaskRequestRoutingDecision,
): TaskRequestRoutingResolution {
  const normalized = validateTaskRequestRoutingDecision(decision);
  const tasks = normalizeRoutingTasks(state.tasks);
  const strongTaskIds = strongOwnershipTaskIds(state.evidence, tasks);
  const requestedTaskId = decisionTaskId(normalized);
  if (requestedTaskId && !tasks.has(requestedTaskId)) {
    invalid("Routing decision references an unavailable task.", { taskId: requestedTaskId });
  }

  if (requiresOwnershipResolution(normalized)) {
    if (strongTaskIds.length > 1) {
      return clarification(normalized, strongTaskIds);
    }
    const strongTaskId = strongTaskIds[0];
    if (strongTaskId && normalized.kind === "create_new_task") {
      return clarification(normalized, [strongTaskId], "use_different_task");
    }
    if (strongTaskId && requestedTaskId && requestedTaskId !== strongTaskId) {
      return clarification(normalized, [strongTaskId, requestedTaskId]);
    }
  }

  switch (normalized.kind) {
    case "continue_active_request": {
      const task = requireTask(tasks, normalized.taskId);
      const lifecycle = lifecycleTransition(normalized, task);
      if (lifecycle) return lifecycle;
      if (task.currentRequest?.id !== normalized.requestId
        || task.currentRequest.status !== "active") {
        return clarification(normalized, [task.taskId], task.currentRequest
          ? "continue_active_request"
          : "create_active_request");
      }
      return ready(normalized, "continue_request", "ready", task, task.currentRequest);
    }
    case "create_active_request": {
      const task = requireTask(tasks, normalized.taskId);
      const lifecycle = lifecycleTransition(normalized, task);
      if (lifecycle) return lifecycle;
      if (task.currentRequest) {
        return clarification(normalized, [task.taskId], "create_queued_request");
      }
      return ready(normalized, "create_active_request", "request_decision_required", task);
    }
    case "create_queued_request": {
      const task = requireTask(tasks, normalized.taskId);
      const lifecycle = lifecycleTransition(normalized, task);
      if (lifecycle) return lifecycle;
      return ready(normalized, "create_queued_request", "not_requested", task);
    }
    case "use_different_task": {
      const task = requireTask(tasks, normalized.taskId);
      const lifecycle = lifecycleTransition(normalized, task);
      if (lifecycle) return lifecycle;
      return ready(
        normalized,
        "select_task",
        task.currentRequest ? "ready" : "request_decision_required",
        task,
        task.currentRequest,
      );
    }
    case "create_new_task":
      return {
        status: "ready",
        decision: normalized,
        next: "create_task",
        mutationReadiness: "task_creation_required",
      };
    case "read_only": {
      const task = normalized.taskId ? requireTask(tasks, normalized.taskId) : undefined;
      return {
        status: "ready",
        decision: normalized,
        next: "answer_read_only",
        mutationReadiness: "not_requested",
        ...(task ? {
          taskId: task.taskId,
          taskStatus: task.status,
          ...(task.currentRequest ? { requestId: task.currentRequest.id } : {}),
        } : {}),
      };
    }
    case "clarify":
      return clarification(normalized, strongTaskIds);
    default:
      return invalid("Request routing decision kind is not supported.");
  }
}

interface NormalizedRoutingTask {
  taskId: string;
  status: "active" | "paused" | "archived";
  currentRequest?: TaskRequest;
}

function normalizeRoutingTasks(
  states: TaskRequestLifecycleState[],
): Map<string, NormalizedRoutingTask> {
  if (states.length > 100) {
    invalid("Routing state exceeds the supported task candidate limit.", { maximum: 100 });
  }
  const tasks = new Map<string, NormalizedRoutingTask>();
  for (const state of states) {
    const requests = listTaskRequests(state);
    const taskId = state.taskCard.id;
    if (tasks.has(taskId)) {
      invalid("Routing state contains a duplicate task identity.", { taskId });
    }
    const currentRequest = state.taskCard.currentRequest
      ? requests.find((request) => request.id === state.taskCard.currentRequest)
      : undefined;
    tasks.set(taskId, {
      taskId,
      status: state.taskCard.status,
      ...(currentRequest ? { currentRequest } : {}),
    });
  }
  return tasks;
}

function strongOwnershipTaskIds(
  evidence: TaskRequestRoutingEvidence | undefined,
  tasks: Map<string, NormalizedRoutingTask>,
): string[] {
  const values = [
    ...(evidence?.explicitTaskId ? [evidence.explicitTaskId] : []),
    ...(evidence?.resourceOwnerTaskIds ?? []),
  ];
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (unique.length > 20) {
    invalid("Routing evidence exceeds the supported strong-identity limit.", { maximum: 20 });
  }
  for (const taskId of unique) {
    if (!isTaskId(taskId) || !tasks.has(taskId)) {
      invalid("Routing evidence references an unavailable task identity.", { taskId });
    }
  }
  return unique;
}

function requiresOwnershipResolution(decision: TaskRequestRoutingDecision): boolean {
  return decision.kind !== "read_only" && decision.kind !== "clarify";
}

function decisionTaskId(decision: TaskRequestRoutingDecision): string | undefined {
  switch (decision.kind) {
    case "continue_active_request":
    case "create_active_request":
    case "create_queued_request":
    case "use_different_task":
    case "read_only":
      return decision.taskId;
    default:
      return undefined;
  }
}

function requireTask(
  tasks: Map<string, NormalizedRoutingTask>,
  taskId: string,
): NormalizedRoutingTask {
  const task = tasks.get(taskId);
  if (!task) invalid("Routing decision references an unavailable task.", { taskId });
  return task;
}

function lifecycleTransition(
  decision: TaskRequestRoutingDecision,
  task: NormalizedRoutingTask,
): TaskRequestRoutingResolution | undefined {
  if (task.status === "active") return undefined;
  return {
    status: "lifecycle_transition_required",
    decision,
    next: "transition_task_lifecycle",
    mutationReadiness: "lifecycle_transition_required",
    taskId: task.taskId,
    taskStatus: task.status,
  };
}

function ready(
  decision: TaskRequestRoutingDecision,
  next: TaskRequestRoutingNext,
  mutationReadiness: TaskRequestMutationReadiness,
  task: NormalizedRoutingTask,
  request?: TaskRequest,
): TaskRequestRoutingResolution {
  return {
    status: "ready",
    decision,
    next,
    mutationReadiness,
    taskId: task.taskId,
    taskStatus: task.status,
    ...(request ? { requestId: request.id } : {}),
  };
}

function clarification(
  decision: TaskRequestRoutingDecision,
  candidateTaskIds: string[],
  recommendedDecision?: TaskRequestRoutingDecision["kind"],
): TaskRequestRoutingResolution {
  return {
    status: "clarification_required",
    decision,
    next: "ask_clarification",
    mutationReadiness: "not_requested",
    ...(candidateTaskIds.length > 0
      ? { candidateTaskIds: [...new Set(candidateTaskIds)].sort() }
      : {}),
    ...(recommendedDecision ? { recommendedDecision } : {}),
  };
}

function taskId(value: string): string {
  if (!isTaskId(value)) invalid("Routing decision contains an invalid task ID.", { taskId: value });
  return value;
}

function requestId(value: string): string {
  if (!isRequestId(value)) {
    invalid("Routing decision contains an invalid request ID.", { requestId: value });
  }
  return value;
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    invalid("Routing decision field is empty or exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
