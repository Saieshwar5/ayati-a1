import { GitContextServiceError } from "../errors.js";
import type { TaskRequestRoutePlanRecord } from "../repositories/task-request-route-plan-records.js";
import type { TaskRepositoryValidation } from "./task-repository-validator.js";
import type { TaskCard } from "./task-card.js";
import type { TaskRequest } from "./task-request.js";

export interface PlannedTaskRequestState {
  taskCard: TaskCard;
  taskRequest: TaskRequest;
  requestCreated: boolean;
}

export function resolvePlannedTaskRequestState(
  record: TaskRequestRoutePlanRecord,
  validation: TaskRepositoryValidation,
): PlannedTaskRequestState {
  if (record.taskId !== validation.taskId || record.baseHead !== validation.head) {
    throw recovery("Pending request plan no longer matches the task repository HEAD.", record);
  }
  if (!record.changePlan) {
    if (validation.currentRequest?.id !== record.taskRequestId
      || validation.currentRequest.status !== "active") {
      throw recovery("Pending continuation plan no longer matches the active request.", record);
    }
    return {
      taskCard: structuredClone(validation.taskCard),
      taskRequest: structuredClone(validation.currentRequest),
      requestCreated: false,
    };
  }
  const plan = record.changePlan;
  if (plan.taskId !== record.taskId || plan.expectedHead !== record.baseHead
    || plan.primaryRequestId !== record.taskRequestId
    || plan.operation !== "create") {
    throw recovery("Pending request plan contains inconsistent identities.", record);
  }
  if (JSON.stringify(plan.taskCardBefore) !== JSON.stringify(validation.taskCard)) {
    throw recovery("Pending request plan no longer matches the committed task card.", record);
  }
  const plannedRequest = plan.requestsAfter.find((request) => request.id === record.taskRequestId);
  if (!plannedRequest || plannedRequest.status !== "active"
    || plan.taskCardAfter.currentRequest !== plannedRequest.id) {
    throw recovery("Pending request plan does not create a valid active request.", record);
  }
  const changedIds = new Set(plan.changedRequests.map((request) => request.id));
  const plannedBefore = plan.requestsAfter.filter((request) => !changedIds.has(request.id));
  if (JSON.stringify(plannedBefore) !== JSON.stringify(validation.requests)) {
    throw recovery("Pending request plan no longer matches committed request history.", record);
  }
  return {
    taskCard: structuredClone(plan.taskCardAfter),
    taskRequest: structuredClone(plannedRequest),
    requestCreated: true,
  };
}

function recovery(
  message: string,
  record: TaskRequestRoutePlanRecord,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    details: {
      runId: record.runId,
      taskId: record.taskId,
      taskRequestId: record.taskRequestId,
      phase: record.phase,
    },
  });
}
