import { ContextEngineServiceError } from "../errors.js";
import type { WorkstreamRequestRoutePlanRecord } from "../repositories/workstream-request-route-plan-records.js";
import type { WorkstreamRequestChangePlan } from "./workstream-request-lifecycle.js";
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
    || (plan.activatedRequestId ?? plan.primaryRequestId) !== record.boundRequestId
    || (plan.operation !== "create" && plan.operation !== "defer_and_create")) {
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
  const plannedBefore = requestsBeforePlan(plan, record.boundRequestId);
  if (!plannedBefore || JSON.stringify(plannedBefore) !== JSON.stringify(validation.requests)) {
    throw recovery("Pending request plan no longer matches committed request history.", record);
  }
  return {
    workstreamCard: structuredClone(plan.workstreamCardAfter),
    workstreamRequest: structuredClone(plannedRequest),
    requestCreated: true,
  };
}

function requestsBeforePlan(
  plan: WorkstreamRequestChangePlan,
  boundRequestId: string,
): WorkstreamRequest[] | undefined {
  if (plan.operation === "create") {
    if (plan.primaryRequestId !== boundRequestId) return undefined;
    return plan.requestsAfter
      .filter((request) => request.id !== boundRequestId)
      .map((request) => structuredClone(request));
  }
  if (plan.operation !== "defer_and_create"
    || plan.activatedRequestId !== boundRequestId
    || plan.workstreamCardBefore.currentRequest !== plan.primaryRequestId) {
    return undefined;
  }
  const deferred = plan.requestsAfter.find((request) => request.id === plan.primaryRequestId);
  if (!deferred || deferred.status !== "queued") return undefined;
  return plan.requestsAfter
    .filter((request) => request.id !== boundRequestId)
    .map((request) => request.id === plan.primaryRequestId
      ? { ...structuredClone(request), status: "active" }
      : structuredClone(request));
}

function recovery(
  message: string,
  record: WorkstreamRequestRoutePlanRecord,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
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
