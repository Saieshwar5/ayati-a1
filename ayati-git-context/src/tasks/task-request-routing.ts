import { GitContextServiceError } from "../errors.js";
import { isRequestId, isTaskId } from "./task-repository-layout.js";

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
  | { kind: "read_only"; reason: string }
  | { kind: "clarify"; reason: string; question: string };

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
    case "read_only":
      return { kind: decision.kind, reason };
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
