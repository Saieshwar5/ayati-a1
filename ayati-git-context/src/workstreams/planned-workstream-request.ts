import { GitContextServiceError } from "../errors.js";
import type { WorkstreamRequestRoutePlanRecord } from "../repositories/workstream-request-route-plan-records.js";
import type { WorkstreamRepositoryValidation } from "./workstream-repository-validator.js";
import type { WorkstreamCard } from "./workstream-card.js";
import type { WorkstreamRequest } from "./workstream-request.js";

export interface PlannedWorkstreamRequestState {
  workstreamCard: WorkstreamCard;
  workstreamRequest: WorkstreamRequest;
  requestCreated: boolean;
}

export function resolvePlannedWorkstreamRequestState(
  record: WorkstreamRequestRoutePlanRecord,
  validation: WorkstreamRepositoryValidation,
): PlannedWorkstreamRequestState {
  if (record.workstreamId !== validation.workstreamId || record.baseHead !== validation.head) {
    throw recovery("Pending request plan no longer matches the workstream repository HEAD.", record);
  }
  if (!record.changePlan) {
    if (validation.currentRequest?.id !== record.boundRequestId
      || validation.currentRequest.status !== "active") {
      throw recovery("Pending continuation plan no longer matches the active request.", record);
    }
    return {
      workstreamCard: structuredClone(validation.workstreamCard),
      workstreamRequest: structuredClone(validation.currentRequest),
      requestCreated: false,
    };
  }
  const plan = record.changePlan;
  if (plan.workstreamId !== record.workstreamId || plan.expectedHead !== record.baseHead
    || plan.primaryRequestId !== record.boundRequestId
    || plan.operation !== "create") {
    throw recovery("Pending request plan contains inconsistent identities.", record);
  }
  if (JSON.stringify(plan.workstreamCardBefore) !== JSON.stringify(validation.workstreamCard)) {
    throw recovery("Pending request plan no longer matches the committed workstream card.", record);
  }
  const plannedRequest = plan.requestsAfter.find((request) => request.id === record.boundRequestId);
  if (!plannedRequest || plannedRequest.status !== "active"
    || plan.workstreamCardAfter.currentRequest !== plannedRequest.id) {
    throw recovery("Pending request plan does not create a valid active request.", record);
  }
  const changedIds = new Set(plan.changedRequests.map((request) => request.id));
  const plannedBefore = plan.requestsAfter.filter((request) => !changedIds.has(request.id));
  if (JSON.stringify(plannedBefore) !== JSON.stringify(validation.requests)) {
    throw recovery("Pending request plan no longer matches committed request history.", record);
  }
  return {
    workstreamCard: structuredClone(plan.workstreamCardAfter),
    workstreamRequest: structuredClone(plannedRequest),
    requestCreated: true,
  };
}

function recovery(
  message: string,
  record: WorkstreamRequestRoutePlanRecord,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    details: {
      runId: record.runId,
      workstreamId: record.workstreamId,
      boundRequestId: record.boundRequestId,
      phase: record.phase,
    },
  });
}
