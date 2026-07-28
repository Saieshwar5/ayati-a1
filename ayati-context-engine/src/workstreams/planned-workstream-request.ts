import { ContextEngineServiceError } from "../errors.js";
import type { WorkstreamRequestRoutePlanRecord } from "../repositories/workstream-request-route-plan-records.js";
import type { WorkstreamCard } from "./workstream-card.js";
import type { WorkstreamRequest } from "./workstream-request.js";
import type { WorkstreamRepositoryValidation } from "./workstream-repository-validator.js";

export interface PlannedWorkstreamRequestState {
  workstreamCard: WorkstreamCard;
  workstreamRequest: WorkstreamRequest;
  requestCreated: boolean;
}

export function resolvePlannedWorkstreamRequestState(
  record: WorkstreamRequestRoutePlanRecord,
  validation: WorkstreamRepositoryValidation,
): PlannedWorkstreamRequestState {
  if (record.workstreamId !== validation.workstreamId
    || record.baseHead !== validation.head) {
    throw recovery("Pending request plan no longer matches the workstream revision.", record);
  }
  if (!record.changePlan) {
    if (record.route.kind !== "continue_current"
      || validation.currentRequest?.id !== record.boundRequestId
      || validation.currentRequest.status !== "active") {
      throw recovery("Continuation plan no longer matches the active request.", record);
    }
    return {
      workstreamCard: structuredClone(validation.workstreamCard),
      workstreamRequest: structuredClone(validation.currentRequest),
      requestCreated: false,
    };
  }
  const plan = record.changePlan;
  if (plan.workstreamId !== record.workstreamId
    || plan.expectedHead !== record.baseHead
    || JSON.stringify(plan.workstreamCardBefore) !== JSON.stringify(validation.workstreamCard)
    || JSON.stringify(plan.requestsBefore) !== JSON.stringify(validation.requests)) {
    throw recovery("Pending request plan no longer matches committed request state.", record);
  }
  const selected = plan.requestsAfter.find(
    (request) => request.id === record.boundRequestId,
  );
  if (!selected || selected.status === "done" || selected.status === "dropped") {
    throw recovery("Pending request plan does not select unfinished work.", record);
  }
  const active = plan.requestsAfter.filter((request) => request.status === "active");
  if (active.length > 1
    || plan.workstreamCardAfter.currentRequest !== (active[0]?.id ?? null)) {
    throw recovery("Pending request plan violates the one-active-request invariant.", record);
  }
  const requestCreated = !plan.requestsBefore.some(
    (request) => request.id === selected.id,
  );
  return {
    workstreamCard: structuredClone(plan.workstreamCardAfter),
    workstreamRequest: structuredClone(selected),
    requestCreated,
  };
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
