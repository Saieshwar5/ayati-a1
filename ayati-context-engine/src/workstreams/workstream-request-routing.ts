import { ContextEngineServiceError } from "../errors.js";
import { isRequestId, isWorkstreamId } from "./workstream-repository-layout.js";
import {
  listWorkstreamRequests,
  type WorkstreamRequestLifecycleState,
} from "./workstream-request-lifecycle.js";
import type { WorkstreamRequest } from "./workstream-request.js";

type RequestOperation =
  | "continue_current"
  | "activate_existing"
  | "resume_blocked"
  | "amend_current"
  | "create_and_activate"
  | "create_queued"
  | "defer_current_and_activate_existing"
  | "defer_current_and_create";

export type WorkstreamRequestRoutingDecision =
  | {
      kind: Extract<
        RequestOperation,
        "continue_current" | "activate_existing" | "resume_blocked" | "amend_current"
      >;
      workstreamId: string;
      requestId: string;
      reason: string;
    }
  | {
      kind: Extract<RequestOperation, "create_and_activate" | "create_queued">;
      workstreamId: string;
      reason: string;
    }
  | {
      kind: "defer_current_and_activate_existing";
      workstreamId: string;
      requestId: string;
      nextRequestId: string;
      reason: string;
    }
  | {
      kind: "defer_current_and_create";
      workstreamId: string;
      requestId: string;
      reason: string;
    }
  | { kind: "use_different_workstream"; workstreamId: string; reason: string }
  | { kind: "create_new_workstream"; reason: string }
  | { kind: "read_only"; reason: string; workstreamId?: string }
  | { kind: "clarify"; reason: string; question: string };

export interface WorkstreamRequestRoutingEvidence {
  explicitWorkstreamId?: string;
  resourceOwnerWorkstreamIds?: string[];
}

export interface WorkstreamRequestRoutingState {
  workstreams: WorkstreamRequestLifecycleState[];
  evidence?: WorkstreamRequestRoutingEvidence;
}

export type WorkstreamRequestRoutingNext =
  | RequestOperation
  | "select_workstream"
  | "create_workstream"
  | "answer_read_only"
  | "ask_clarification"
  | "transition_workstream_lifecycle";

export type WorkstreamRequestMutationReadiness =
  | "ready"
  | "request_decision_required"
  | "workstream_creation_required"
  | "lifecycle_transition_required"
  | "not_requested";

export interface WorkstreamRequestRoutingResolution {
  status: "ready" | "clarification_required" | "lifecycle_transition_required";
  decision: WorkstreamRequestRoutingDecision;
  next: WorkstreamRequestRoutingNext;
  mutationReadiness: WorkstreamRequestMutationReadiness;
  workstreamId?: string;
  requestId?: string;
  candidateWorkstreamIds?: string[];
  workstreamStatus?: "active" | "paused" | "archived";
  recommendedDecision?: WorkstreamRequestRoutingDecision["kind"];
}

export function validateWorkstreamRequestRoutingDecision(
  decision: WorkstreamRequestRoutingDecision,
): WorkstreamRequestRoutingDecision {
  const reason = boundedLine(decision.reason, "reason", 500);
  switch (decision.kind) {
    case "continue_current":
    case "activate_existing":
    case "resume_blocked":
    case "amend_current":
    case "defer_current_and_create":
      return {
        kind: decision.kind,
        workstreamId: workstreamId(decision.workstreamId),
        requestId: requestId(decision.requestId),
        reason,
      };
    case "defer_current_and_activate_existing":
      return {
        kind: decision.kind,
        workstreamId: workstreamId(decision.workstreamId),
        requestId: requestId(decision.requestId),
        nextRequestId: requestId(decision.nextRequestId),
        reason,
      };
    case "create_and_activate":
    case "create_queued":
    case "use_different_workstream":
      return {
        kind: decision.kind,
        workstreamId: workstreamId(decision.workstreamId),
        reason,
      };
    case "create_new_workstream":
      return { kind: decision.kind, reason };
    case "read_only":
      return {
        kind: decision.kind,
        reason,
        ...(decision.workstreamId
          ? { workstreamId: workstreamId(decision.workstreamId) }
          : {}),
      };
    case "clarify":
      return {
        kind: decision.kind,
        reason,
        question: boundedLine(decision.question, "question", 500),
      };
  }
}

export function resolveWorkstreamRequestRoutingDecision(
  state: WorkstreamRequestRoutingState,
  decision: WorkstreamRequestRoutingDecision,
): WorkstreamRequestRoutingResolution {
  const normalized = validateWorkstreamRequestRoutingDecision(decision);
  const workstreams = normalizeWorkstreams(state.workstreams);
  const owners = strongOwners(state.evidence, workstreams);
  const selectedId = decisionWorkstreamId(normalized);
  if (selectedId && !workstreams.has(selectedId)) {
    invalid("Routing decision references an unavailable workstream.", {
      workstreamId: selectedId,
    });
  }
  if (normalized.kind !== "read_only" && normalized.kind !== "clarify") {
    if (owners.length > 1) return clarification(normalized, owners);
    const owner = owners[0];
    if (owner && normalized.kind === "create_new_workstream") {
      return clarification(normalized, [owner], "use_different_workstream");
    }
    if (owner && selectedId && owner !== selectedId) {
      return clarification(normalized, [owner, selectedId]);
    }
  }

  if (normalized.kind === "create_new_workstream") {
    return readyWithoutWorkstream(normalized, "create_workstream", "workstream_creation_required");
  }
  if (normalized.kind === "clarify") return clarification(normalized, owners);
  if (normalized.kind === "read_only") {
    const workstream = normalized.workstreamId
      ? requireWorkstream(workstreams, normalized.workstreamId)
      : undefined;
    return {
      status: "ready",
      decision: normalized,
      next: "answer_read_only",
      mutationReadiness: "not_requested",
      ...(workstream ? {
        workstreamId: workstream.workstreamId,
        workstreamStatus: workstream.status,
        ...(workstream.current ? { requestId: workstream.current.id } : {}),
      } : {}),
    };
  }
  const workstream = requireWorkstream(workstreams, normalized.workstreamId);
  const lifecycle = requireActiveLifecycle(normalized, workstream);
  if (lifecycle) return lifecycle;
  if (normalized.kind === "use_different_workstream") {
    return ready(
      normalized,
      "select_workstream",
      workstream.current ? "ready" : "request_decision_required",
      workstream,
      workstream.current,
    );
  }

  switch (normalized.kind) {
    case "continue_current": {
      const request = requestWithStatus(workstream, normalized.requestId, "active");
      if (!request || workstream.current?.id !== request.id) {
        return clarification(normalized, [workstream.workstreamId]);
      }
      return ready(normalized, normalized.kind, "ready", workstream, request);
    }
    case "activate_existing": {
      if (workstream.current) return clarification(normalized, [workstream.workstreamId]);
      const request = requestWithStatus(workstream, normalized.requestId, "queued");
      if (!request) return clarification(normalized, [workstream.workstreamId]);
      return ready(normalized, normalized.kind, "request_decision_required", workstream, request);
    }
    case "resume_blocked": {
      if (workstream.current) return clarification(normalized, [workstream.workstreamId]);
      const request = requestWithStatus(workstream, normalized.requestId, "blocked");
      if (!request) return clarification(normalized, [workstream.workstreamId]);
      return ready(normalized, normalized.kind, "request_decision_required", workstream, request);
    }
    case "amend_current": {
      if (workstream.current?.id !== normalized.requestId) {
        return clarification(normalized, [workstream.workstreamId]);
      }
      return ready(normalized, normalized.kind, "request_decision_required", workstream, workstream.current);
    }
    case "create_and_activate":
      if (workstream.current) return clarification(
        normalized,
        [workstream.workstreamId],
        "defer_current_and_create",
      );
      return ready(normalized, normalized.kind, "request_decision_required", workstream);
    case "create_queued":
      return ready(normalized, normalized.kind, "not_requested", workstream);
    case "defer_current_and_create":
      if (workstream.current?.id !== normalized.requestId) {
        return clarification(normalized, [workstream.workstreamId]);
      }
      return ready(normalized, normalized.kind, "request_decision_required", workstream, workstream.current);
    case "defer_current_and_activate_existing": {
      if (workstream.current?.id !== normalized.requestId) {
        return clarification(normalized, [workstream.workstreamId]);
      }
      const next = requestWithStatus(workstream, normalized.nextRequestId, "queued");
      if (!next) return clarification(normalized, [workstream.workstreamId]);
      return ready(normalized, normalized.kind, "request_decision_required", workstream, next);
    }
  }
}

interface RoutingWorkstream {
  workstreamId: string;
  status: "active" | "paused" | "archived";
  requests: WorkstreamRequest[];
  current?: WorkstreamRequest;
}

function normalizeWorkstreams(
  states: WorkstreamRequestLifecycleState[],
): Map<string, RoutingWorkstream> {
  if (states.length > 100) invalid("Routing state exceeds 100 workstreams.");
  const result = new Map<string, RoutingWorkstream>();
  for (const state of states) {
    const requests = listWorkstreamRequests(state);
    const id = state.workstreamCard.id;
    if (result.has(id)) invalid("Routing state contains a duplicate workstream.", { id });
    const current = state.workstreamCard.currentRequest
      ? requests.find((request) => request.id === state.workstreamCard.currentRequest)
      : undefined;
    result.set(id, {
      workstreamId: id,
      status: state.workstreamCard.status,
      requests,
      ...(current ? { current } : {}),
    });
  }
  return result;
}

function requestWithStatus(
  workstream: RoutingWorkstream,
  requestIdValue: string,
  status: WorkstreamRequest["status"],
): WorkstreamRequest | undefined {
  return workstream.requests.find(
    (request) => request.id === requestIdValue && request.status === status,
  );
}

function strongOwners(
  evidence: WorkstreamRequestRoutingEvidence | undefined,
  workstreams: Map<string, RoutingWorkstream>,
): string[] {
  const values = [
    ...(evidence?.explicitWorkstreamId ? [evidence.explicitWorkstreamId] : []),
    ...(evidence?.resourceOwnerWorkstreamIds ?? []),
  ];
  const unique = [...new Set(values)].sort();
  if (unique.length > 20) invalid("Routing evidence exceeds 20 strong identities.");
  for (const id of unique) {
    if (!isWorkstreamId(id) || !workstreams.has(id)) {
      invalid("Routing evidence references an unavailable workstream.", { id });
    }
  }
  return unique;
}

function decisionWorkstreamId(
  decision: WorkstreamRequestRoutingDecision,
): string | undefined {
  return "workstreamId" in decision ? decision.workstreamId : undefined;
}

function requireWorkstream(
  workstreams: Map<string, RoutingWorkstream>,
  id: string,
): RoutingWorkstream {
  const workstream = workstreams.get(id);
  if (!workstream) invalid("Routing decision references an unavailable workstream.", { id });
  return workstream;
}

function requireActiveLifecycle(
  decision: WorkstreamRequestRoutingDecision,
  workstream: RoutingWorkstream,
): WorkstreamRequestRoutingResolution | undefined {
  if (workstream.status === "active") return undefined;
  return {
    status: "lifecycle_transition_required",
    decision,
    next: "transition_workstream_lifecycle",
    mutationReadiness: "lifecycle_transition_required",
    workstreamId: workstream.workstreamId,
    workstreamStatus: workstream.status,
  };
}

function ready(
  decision: WorkstreamRequestRoutingDecision,
  next: WorkstreamRequestRoutingNext,
  mutationReadiness: WorkstreamRequestMutationReadiness,
  workstream: RoutingWorkstream,
  request?: WorkstreamRequest,
): WorkstreamRequestRoutingResolution {
  return {
    status: "ready",
    decision,
    next,
    mutationReadiness,
    workstreamId: workstream.workstreamId,
    workstreamStatus: workstream.status,
    ...(request ? { requestId: request.id } : {}),
  };
}

function readyWithoutWorkstream(
  decision: WorkstreamRequestRoutingDecision,
  next: WorkstreamRequestRoutingNext,
  mutationReadiness: WorkstreamRequestMutationReadiness,
): WorkstreamRequestRoutingResolution {
  return { status: "ready", decision, next, mutationReadiness };
}

function clarification(
  decision: WorkstreamRequestRoutingDecision,
  candidates: string[],
  recommendedDecision?: WorkstreamRequestRoutingDecision["kind"],
): WorkstreamRequestRoutingResolution {
  return {
    status: "clarification_required",
    decision,
    next: "ask_clarification",
    mutationReadiness: "not_requested",
    ...(candidates.length > 0
      ? { candidateWorkstreamIds: [...new Set(candidates)].sort() }
      : {}),
    ...(recommendedDecision ? { recommendedDecision } : {}),
  };
}

function workstreamId(value: string): string {
  if (!isWorkstreamId(value)) invalid("Routing decision has an invalid workstream ID.");
  return value;
}

function requestId(value: string): string {
  if (!isRequestId(value)) invalid("Routing decision has an invalid request ID.");
  return value;
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    invalid("Routing decision field is empty or too long.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ContextEngineServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
