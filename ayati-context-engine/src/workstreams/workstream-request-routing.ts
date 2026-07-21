import { ContextEngineServiceError } from "../errors.js";
import { isRequestId, isWorkstreamId } from "./workstream-repository-layout.js";
import {
  listWorkstreamRequests,
  type WorkstreamRequestLifecycleState,
} from "./workstream-request-lifecycle.js";
import type { WorkstreamRequest } from "./workstream-request.js";

export type WorkstreamRequestRoutingDecision =
  | {
      kind: "continue_active_request";
      workstreamId: string;
      requestId: string;
      reason: string;
    }
  | {
      kind: "create_active_request" | "create_queued_request";
      workstreamId: string;
      reason: string;
    }
  | { kind: "use_different_workstream"; workstreamId: string; reason: string }
  | { kind: "create_new_workstream"; reason: string }
  | { kind: "read_only"; reason: string; workstreamId?: string }
  | { kind: "clarify"; reason: string; question: string };

export interface WorkstreamRequestRoutingEvidence {
  /** Exact workstream identity explicitly supplied by the user or a trusted caller. */
  explicitWorkstreamId?: string;
  /** Workstream identities proven to own named files, directories, or resources. */
  resourceOwnerWorkstreamIds?: string[];
}

export interface WorkstreamRequestRoutingState {
  workstreams: WorkstreamRequestLifecycleState[];
  evidence?: WorkstreamRequestRoutingEvidence;
}

export type WorkstreamRequestRoutingNext =
  | "continue_request"
  | "create_active_request"
  | "create_queued_request"
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
    case "continue_active_request":
      return {
        kind: decision.kind,
        workstreamId: workstreamId(decision.workstreamId),
        requestId: requestId(decision.requestId),
        reason,
      };
    case "create_active_request":
    case "create_queued_request":
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
        ...(decision.workstreamId ? { workstreamId: workstreamId(decision.workstreamId) } : {}),
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
 * Resolves an explicit routing decision against durable workstream/request state.
 * Natural-language classification remains outside this pure policy boundary.
 */
export function resolveWorkstreamRequestRoutingDecision(
  state: WorkstreamRequestRoutingState,
  decision: WorkstreamRequestRoutingDecision,
): WorkstreamRequestRoutingResolution {
  const normalized = validateWorkstreamRequestRoutingDecision(decision);
  const workstreams = normalizeRoutingWorkstreams(state.workstreams);
  const strongWorkstreamIds = strongOwnershipWorkstreamIds(state.evidence, workstreams);
  const requestedWorkstreamId = decisionWorkstreamId(normalized);
  if (requestedWorkstreamId && !workstreams.has(requestedWorkstreamId)) {
    invalid("Routing decision references an unavailable workstream.", { workstreamId: requestedWorkstreamId });
  }

  if (requiresOwnershipResolution(normalized)) {
    if (strongWorkstreamIds.length > 1) {
      return clarification(normalized, strongWorkstreamIds);
    }
    const strongWorkstreamId = strongWorkstreamIds[0];
    if (strongWorkstreamId && normalized.kind === "create_new_workstream") {
      return clarification(normalized, [strongWorkstreamId], "use_different_workstream");
    }
    if (strongWorkstreamId && requestedWorkstreamId && requestedWorkstreamId !== strongWorkstreamId) {
      return clarification(normalized, [strongWorkstreamId, requestedWorkstreamId]);
    }
  }

  switch (normalized.kind) {
    case "continue_active_request": {
      const workstream = requireWorkstream(workstreams, normalized.workstreamId);
      const lifecycle = lifecycleTransition(normalized, workstream);
      if (lifecycle) return lifecycle;
      if (workstream.currentRequest?.id !== normalized.requestId
        || workstream.currentRequest.status !== "active") {
        return clarification(normalized, [workstream.workstreamId], workstream.currentRequest
          ? "continue_active_request"
          : "create_active_request");
      }
      return ready(normalized, "continue_request", "ready", workstream, workstream.currentRequest);
    }
    case "create_active_request": {
      const workstream = requireWorkstream(workstreams, normalized.workstreamId);
      const lifecycle = lifecycleTransition(normalized, workstream);
      if (lifecycle) return lifecycle;
      if (workstream.currentRequest) {
        return clarification(normalized, [workstream.workstreamId], "create_queued_request");
      }
      return ready(normalized, "create_active_request", "request_decision_required", workstream);
    }
    case "create_queued_request": {
      const workstream = requireWorkstream(workstreams, normalized.workstreamId);
      const lifecycle = lifecycleTransition(normalized, workstream);
      if (lifecycle) return lifecycle;
      return ready(normalized, "create_queued_request", "not_requested", workstream);
    }
    case "use_different_workstream": {
      const workstream = requireWorkstream(workstreams, normalized.workstreamId);
      const lifecycle = lifecycleTransition(normalized, workstream);
      if (lifecycle) return lifecycle;
      return ready(
        normalized,
        "select_workstream",
        workstream.currentRequest ? "ready" : "request_decision_required",
        workstream,
        workstream.currentRequest,
      );
    }
    case "create_new_workstream":
      return {
        status: "ready",
        decision: normalized,
        next: "create_workstream",
        mutationReadiness: "workstream_creation_required",
      };
    case "read_only": {
      const workstream = normalized.workstreamId ? requireWorkstream(workstreams, normalized.workstreamId) : undefined;
      return {
        status: "ready",
        decision: normalized,
        next: "answer_read_only",
        mutationReadiness: "not_requested",
        ...(workstream ? {
          workstreamId: workstream.workstreamId,
          workstreamStatus: workstream.status,
          ...(workstream.currentRequest ? { requestId: workstream.currentRequest.id } : {}),
        } : {}),
      };
    }
    case "clarify":
      return clarification(normalized, strongWorkstreamIds);
    default:
      return invalid("Request routing decision kind is not supported.");
  }
}

interface NormalizedRoutingWorkstream {
  workstreamId: string;
  status: "active" | "paused" | "archived";
  currentRequest?: WorkstreamRequest;
}

function normalizeRoutingWorkstreams(
  states: WorkstreamRequestLifecycleState[],
): Map<string, NormalizedRoutingWorkstream> {
  if (states.length > 100) {
    invalid("Routing state exceeds the supported workstream candidate limit.", { maximum: 100 });
  }
  const workstreams = new Map<string, NormalizedRoutingWorkstream>();
  for (const state of states) {
    const requests = listWorkstreamRequests(state);
    const workstreamId = state.workstreamCard.id;
    if (workstreams.has(workstreamId)) {
      invalid("Routing state contains a duplicate workstream identity.", { workstreamId });
    }
    const currentRequest = state.workstreamCard.currentRequest
      ? requests.find((request) => request.id === state.workstreamCard.currentRequest)
      : undefined;
    workstreams.set(workstreamId, {
      workstreamId,
      status: state.workstreamCard.status,
      ...(currentRequest ? { currentRequest } : {}),
    });
  }
  return workstreams;
}

function strongOwnershipWorkstreamIds(
  evidence: WorkstreamRequestRoutingEvidence | undefined,
  workstreams: Map<string, NormalizedRoutingWorkstream>,
): string[] {
  const values = [
    ...(evidence?.explicitWorkstreamId ? [evidence.explicitWorkstreamId] : []),
    ...(evidence?.resourceOwnerWorkstreamIds ?? []),
  ];
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (unique.length > 20) {
    invalid("Routing evidence exceeds the supported strong-identity limit.", { maximum: 20 });
  }
  for (const workstreamId of unique) {
    if (!isWorkstreamId(workstreamId) || !workstreams.has(workstreamId)) {
      invalid("Routing evidence references an unavailable workstream identity.", { workstreamId });
    }
  }
  return unique;
}

function requiresOwnershipResolution(decision: WorkstreamRequestRoutingDecision): boolean {
  return decision.kind !== "read_only" && decision.kind !== "clarify";
}

function decisionWorkstreamId(decision: WorkstreamRequestRoutingDecision): string | undefined {
  switch (decision.kind) {
    case "continue_active_request":
    case "create_active_request":
    case "create_queued_request":
    case "use_different_workstream":
    case "read_only":
      return decision.workstreamId;
    default:
      return undefined;
  }
}

function requireWorkstream(
  workstreams: Map<string, NormalizedRoutingWorkstream>,
  workstreamId: string,
): NormalizedRoutingWorkstream {
  const workstream = workstreams.get(workstreamId);
  if (!workstream) invalid("Routing decision references an unavailable workstream.", { workstreamId });
  return workstream;
}

function lifecycleTransition(
  decision: WorkstreamRequestRoutingDecision,
  workstream: NormalizedRoutingWorkstream,
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
  workstream: NormalizedRoutingWorkstream,
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

function clarification(
  decision: WorkstreamRequestRoutingDecision,
  candidateWorkstreamIds: string[],
  recommendedDecision?: WorkstreamRequestRoutingDecision["kind"],
): WorkstreamRequestRoutingResolution {
  return {
    status: "clarification_required",
    decision,
    next: "ask_clarification",
    mutationReadiness: "not_requested",
    ...(candidateWorkstreamIds.length > 0
      ? { candidateWorkstreamIds: [...new Set(candidateWorkstreamIds)].sort() }
      : {}),
    ...(recommendedDecision ? { recommendedDecision } : {}),
  };
}

function workstreamId(value: string): string {
  if (!isWorkstreamId(value)) invalid("Routing decision contains an invalid workstream ID.", { workstreamId: value });
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
  throw new ContextEngineServiceError({
    code: "INVALID_REQUEST",
    message,
    ...(details ? { details } : {}),
  });
}
