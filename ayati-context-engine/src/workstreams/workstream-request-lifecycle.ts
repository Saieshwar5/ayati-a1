import { ContextEngineServiceError } from "../errors.js";
import { renderWorkstreamCard, type WorkstreamCard } from "./workstream-card.js";
import {
  nextRequestId,
  requestPath,
  WORKSTREAM_CARD_PATH,
} from "./workstream-repository-layout.js";
import {
  renderWorkstreamRequest,
  validateWorkstreamRequestTransition,
  type WorkstreamRequest,
  type WorkstreamRequestSource,
} from "./workstream-request.js";

export interface WorkstreamRequestLifecycleState {
  expectedHead: string;
  workstreamCard: WorkstreamCard;
  requests: WorkstreamRequest[];
}

export type WorkstreamRequestLifecycleOperation =
  | {
      kind: "create";
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
      source: WorkstreamRequestSource;
      createdAt: string;
      activate: boolean;
    }
  | { kind: "activate"; requestId: string }
  | { kind: "block"; requestId: string; reason: string }
  | { kind: "resume"; requestId: string }
  | {
      kind: "complete";
      requestId: string;
      outcome: string;
      verification: "verified" | "user_accepted";
      activateNextRequestId?: string;
    }
  | { kind: "drop"; requestId: string; reason: string }
  | {
      kind: "reopen";
      requestId: string;
      reason: string;
      explicitSameIntention: boolean;
    };

export interface WorkstreamRequestFileWrite {
  path: string;
  content: string;
}

export interface WorkstreamRequestChangePlan {
  operation: WorkstreamRequestLifecycleOperation["kind"];
  expectedHead: string;
  workstreamId: string;
  primaryRequestId: string;
  activatedRequestId?: string;
  completionVerification?: "verified" | "user_accepted";
  workstreamCardBefore: WorkstreamCard;
  workstreamCardAfter: WorkstreamCard;
  requestsAfter: WorkstreamRequest[];
  changedRequests: WorkstreamRequest[];
  writes: WorkstreamRequestFileWrite[];
  deletedPaths: [];
}

export function planWorkstreamRequestChange(
  state: WorkstreamRequestLifecycleState,
  operation: WorkstreamRequestLifecycleOperation,
): WorkstreamRequestChangePlan {
  const current = normalizeState(state);
  requireMutableWorkstream(current.workstreamCard);
  switch (operation.kind) {
    case "create":
      return createRequest(current, operation);
    case "activate":
      return activateRequest(current, operation.requestId);
    case "block":
      return blockRequest(current, operation.requestId, operation.reason);
    case "resume":
      return resumeRequest(current, operation.requestId);
    case "complete":
      return completeRequest(current, operation);
    case "drop":
      return dropRequest(current, operation.requestId, operation.reason);
    case "reopen":
      return reopenRequest(current, operation);
    default:
      return invalid("Workstream request lifecycle operation is not supported.");
  }
}

export function listWorkstreamRequests(state: WorkstreamRequestLifecycleState): WorkstreamRequest[] {
  return normalizeState(state).requests.map(cloneRequest);
}

export function readWorkstreamRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
): WorkstreamRequest {
  return cloneRequest(requireRequest(normalizeState(state).requests, requestId));
}

function createRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "create" }>,
): WorkstreamRequestChangePlan {
  if (operation.activate) requireActiveWorkstream(state.workstreamCard);
  if (operation.source === "agent_proposal" && operation.activate) {
    invalid("Agent proposals must begin queued and cannot be activated implicitly.");
  }
  if (operation.activate) requireNoActiveRequest(state.requests);
  const request: WorkstreamRequest = {
    schema: "ayati.request/v2",
    id: nextRequestId(state.requests.map((entry) => entry.id)),
    title: operation.title,
    status: operation.activate ? "active" : "queued",
    createdAt: operation.createdAt,
    source: operation.source,
    request: operation.request,
    acceptance: [...operation.acceptance],
    constraints: [...operation.constraints],
    outcome: "Not completed yet.",
  };
  renderWorkstreamRequest(request);
  const workstreamCard = operation.activate
    ? activateWorkstreamCard(state.workstreamCard, request)
    : cloneCard(state.workstreamCard);
  return buildPlan(state, "create", request.id, workstreamCard, [
    ...state.requests,
    request,
  ], [request], operation.activate ? request.id : undefined);
}

function activateRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  requireNoActiveRequest(state.requests);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "queued") {
    invalid("Only a queued request can be activated; blocked requests must be resumed.", {
      requestId,
      status: before.status,
    });
  }
  validateWorkstreamRequestTransition({ from: before.status, to: "active" });
  const after = { ...cloneRequest(before), status: "active" as const };
  return buildPlan(
    state,
    "activate",
    requestId,
    activateWorkstreamCard(state.workstreamCard, after),
    replaceRequest(state.requests, after),
    [after],
    requestId,
  );
}

function blockRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  reason: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  const before = requireCurrentRequest(state, requestId);
  validateWorkstreamRequestTransition({ from: before.status, to: "blocked" });
  const normalizedReason = boundedLine(reason, "blocking reason", 400);
  const after: WorkstreamRequest = {
    ...cloneRequest(before),
    status: "blocked",
    outcome: "Blocked: " + normalizedReason,
  };
  const workstreamCard = cloneCard(state.workstreamCard);
  workstreamCard.currentRequest = null;
  workstreamCard.currentFocus = "Resolve the blocker for " + requestId + ": " + before.title + ".";
  workstreamCard.blockers = withoutRequestBlocker(workstreamCard.blockers, requestId);
  workstreamCard.blockers.push(requestBlocker(requestId, normalizedReason));
  return buildPlan(state, "block", requestId, workstreamCard, replaceRequest(
    state.requests,
    after,
  ), [after]);
}

function resumeRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  requireNoActiveRequest(state.requests);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "blocked") {
    invalid("Only a blocked request can be resumed.", { requestId, status: before.status });
  }
  validateWorkstreamRequestTransition({ from: before.status, to: "active" });
  const after: WorkstreamRequest = {
    ...cloneRequest(before),
    status: "active",
    outcome: "Work resumed; completion is still pending.",
  };
  const workstreamCard = activateWorkstreamCard(state.workstreamCard, after);
  workstreamCard.blockers = withoutRequestBlocker(workstreamCard.blockers, requestId);
  return buildPlan(
    state,
    "resume",
    requestId,
    workstreamCard,
    replaceRequest(state.requests, after),
    [after],
    requestId,
  );
}

function completeRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "complete" }>,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  const before = requireCurrentRequest(state, operation.requestId);
  if (operation.verification !== "verified" && operation.verification !== "user_accepted") {
    invalid("Completing a request requires deterministic verification or explicit user acceptance.");
  }
  validateWorkstreamRequestTransition({ from: before.status, to: "done" });
  const after: WorkstreamRequest = {
    ...cloneRequest(before),
    status: "done",
    outcome: boundedText(operation.outcome, "completion outcome", 2_000),
  };
  let requests = replaceRequest(state.requests, after);
  let workstreamCard = cloneCard(state.workstreamCard);
  workstreamCard.currentRequest = null;
  workstreamCard.currentFocus = "Choose or create the next request.";
  workstreamCard.blockers = withoutRequestBlocker(workstreamCard.blockers, operation.requestId);
  const changed = [after];
  let activatedRequestId: string | undefined;
  if (operation.activateNextRequestId) {
    const next = requireRequest(requests, operation.activateNextRequestId);
    if (next.status !== "queued") {
      invalid("The next authorized request must be queued.", {
        requestId: next.id,
        status: next.status,
      });
    }
    validateWorkstreamRequestTransition({ from: next.status, to: "active" });
    const activated: WorkstreamRequest = { ...cloneRequest(next), status: "active" };
    requests = replaceRequest(requests, activated);
    workstreamCard = activateWorkstreamCard(workstreamCard, activated);
    changed.push(activated);
    activatedRequestId = activated.id;
  }
  return buildPlan(
    state,
    "complete",
    operation.requestId,
    workstreamCard,
    requests,
    changed,
    activatedRequestId,
    operation.verification,
  );
}

function dropRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  reason: string,
): WorkstreamRequestChangePlan {
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "queued" && before.status !== "active" && before.status !== "blocked") {
    invalid("Only a queued, active, or blocked request can be dropped.", {
      requestId,
      status: before.status,
    });
  }
  validateWorkstreamRequestTransition({ from: before.status, to: "dropped" });
  const after: WorkstreamRequest = {
    ...cloneRequest(before),
    status: "dropped",
    outcome: "Dropped: " + boundedLine(reason, "drop reason", 400),
  };
  const workstreamCard = cloneCard(state.workstreamCard);
  if (workstreamCard.currentRequest === requestId) {
    workstreamCard.currentRequest = null;
    workstreamCard.currentFocus = "Choose or create the next request.";
  }
  workstreamCard.blockers = withoutRequestBlocker(workstreamCard.blockers, requestId);
  return buildPlan(state, "drop", requestId, workstreamCard, replaceRequest(
    state.requests,
    after,
  ), [after]);
}

function reopenRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "reopen" }>,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  requireNoActiveRequest(state.requests);
  if (operation.explicitSameIntention !== true) {
    invalid("Reopening a completed request requires explicit same-intention confirmation.");
  }
  const before = requireRequest(state.requests, operation.requestId);
  validateWorkstreamRequestTransition({
    from: before.status,
    to: "active",
    explicitReopen: operation.explicitSameIntention,
  });
  const after: WorkstreamRequest = {
    ...cloneRequest(before),
    status: "active",
    outcome: "Reopened: " + boundedLine(operation.reason, "reopen reason", 400),
  };
  return buildPlan(
    state,
    "reopen",
    operation.requestId,
    activateWorkstreamCard(state.workstreamCard, after),
    replaceRequest(state.requests, after),
    [after],
    after.id,
  );
}

function buildPlan(
  before: WorkstreamRequestLifecycleState,
  operation: WorkstreamRequestChangePlan["operation"],
  primaryRequestId: string,
  workstreamCard: WorkstreamCard,
  requests: WorkstreamRequest[],
  changedRequests: WorkstreamRequest[],
  activatedRequestId?: string,
  completionVerification?: "verified" | "user_accepted",
): WorkstreamRequestChangePlan {
  const after = normalizeState({
    expectedHead: before.expectedHead,
    workstreamCard,
    requests,
  });
  const workstreamCardBefore = cloneCard(before.workstreamCard);
  const workstreamCardAfter = cloneCard(after.workstreamCard);
  const workstreamCardChanged = renderWorkstreamCard(workstreamCardBefore) !== renderWorkstreamCard(workstreamCardAfter);
  const writes: WorkstreamRequestFileWrite[] = changedRequests.map((request) => ({
    path: requestPath(request.id, request.title),
    content: renderWorkstreamRequest(request),
  }));
  if (workstreamCardChanged) {
    writes.push({ path: WORKSTREAM_CARD_PATH, content: renderWorkstreamCard(workstreamCardAfter) });
  }
  writes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    operation,
    expectedHead: before.expectedHead,
    workstreamId: before.workstreamCard.id,
    primaryRequestId,
    ...(activatedRequestId ? { activatedRequestId } : {}),
    ...(completionVerification ? { completionVerification } : {}),
    workstreamCardBefore,
    workstreamCardAfter,
    requestsAfter: after.requests.map(cloneRequest),
    changedRequests: changedRequests.map(cloneRequest),
    writes,
    deletedPaths: [],
  };
}

function normalizeState(state: WorkstreamRequestLifecycleState): WorkstreamRequestLifecycleState {
  if (!/^[a-f0-9]{40,64}$/.test(state.expectedHead)) {
    invalid("Request planning requires a lowercase Git object identity as expected HEAD.");
  }
  const workstreamCard = cloneCard(state.workstreamCard);
  renderWorkstreamCard(workstreamCard);
  const requests = state.requests.map(cloneRequest).sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const request of requests) {
    renderWorkstreamRequest(request);
    if (seen.has(request.id)) invalid("Workstream request state contains duplicate identities.", {
      requestId: request.id,
    });
    seen.add(request.id);
  }
  const active = requests.filter((request) => request.status === "active");
  if (active.length > 1) {
    invalid("Workstream request state contains more than one active request.", {
      activeRequestIds: active.map((request) => request.id),
    });
  }
  if (workstreamCard.status !== "active" && active.length > 0) {
    invalid("Paused or archived workstreams cannot contain an active request.");
  }
  const activeId = active[0]?.id ?? null;
  if (workstreamCard.currentRequest !== activeId) {
    invalid("Workstream card current_request must match the one active request or be none.", {
      currentRequest: workstreamCard.currentRequest,
      activeRequestId: activeId,
    });
  }
  return { expectedHead: state.expectedHead, workstreamCard, requests };
}

function requireMutableWorkstream(workstreamCard: WorkstreamCard): void {
  if (workstreamCard.status === "archived") {
    invalid("Archived workstreams must be explicitly reopened before changing requests.");
  }
}

function requireActiveWorkstream(workstreamCard: WorkstreamCard): void {
  if (workstreamCard.status !== "active") {
    invalid("A request can become active only inside an active workstream.", {
      workstreamStatus: workstreamCard.status,
    });
  }
}

function requireNoActiveRequest(requests: WorkstreamRequest[]): void {
  const active = requests.find((request) => request.status === "active");
  if (active) invalid("Another request is already active.", { activeRequestId: active.id });
}

function requireCurrentRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
): WorkstreamRequest {
  const request = requireRequest(state.requests, requestId);
  if (request.status !== "active" || state.workstreamCard.currentRequest !== requestId) {
    invalid("Operation requires the workstream's current active request.", {
      requestId,
      status: request.status,
      currentRequest: state.workstreamCard.currentRequest,
    });
  }
  return request;
}

function requireRequest(requests: WorkstreamRequest[], requestId: string): WorkstreamRequest {
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) invalid("Workstream request does not exist.", { requestId });
  return request;
}

function activateWorkstreamCard(workstreamCard: WorkstreamCard, request: WorkstreamRequest): WorkstreamCard {
  const result = cloneCard(workstreamCard);
  result.currentRequest = request.id;
  result.currentFocus = "Complete " + request.id + ": " + request.title + ".";
  return result;
}

function requestBlocker(requestId: string, reason: string): string {
  return "Request " + requestId + ": " + reason;
}

function withoutRequestBlocker(blockers: string[], requestId: string): string[] {
  const prefix = "Request " + requestId + ":";
  return blockers.filter((blocker) => !blocker.startsWith(prefix));
}

function replaceRequest(requests: WorkstreamRequest[], replacement: WorkstreamRequest): WorkstreamRequest[] {
  return requests.map((request) => request.id === replacement.id
    ? cloneRequest(replacement)
    : cloneRequest(request));
}

function cloneCard(card: WorkstreamCard): WorkstreamCard {
  return {
    ...card,
    blockers: [...card.blockers],
    workingAgreements: [...card.workingAgreements],
  };
}

function cloneRequest(request: WorkstreamRequest): WorkstreamRequest {
  return {
    ...request,
    acceptance: [...request.acceptance],
    constraints: [...request.constraints],
  };
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    invalid("Workstream request field is empty or exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    invalid("Workstream request field is empty or exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REQUEST_STATE_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
