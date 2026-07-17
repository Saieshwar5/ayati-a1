import { GitContextServiceError } from "../errors.js";
import { renderTaskCard, type TaskCard } from "./task-card.js";
import {
  nextRequestId,
  requestPath,
  TASK_CARD_PATH,
} from "./task-repository-layout.js";
import {
  renderTaskRequest,
  validateTaskRequestTransition,
  type TaskRequest,
  type TaskRequestSource,
} from "./task-request.js";

export interface TaskRequestLifecycleState {
  expectedHead: string;
  taskCard: TaskCard;
  requests: TaskRequest[];
}

export type TaskRequestLifecycleOperation =
  | {
      kind: "create";
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
      source: TaskRequestSource;
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

export interface TaskRequestFileWrite {
  path: string;
  content: string;
}

export interface TaskRequestChangePlan {
  operation: TaskRequestLifecycleOperation["kind"];
  expectedHead: string;
  taskId: string;
  primaryRequestId: string;
  activatedRequestId?: string;
  completionVerification?: "verified" | "user_accepted";
  taskCardBefore: TaskCard;
  taskCardAfter: TaskCard;
  requestsAfter: TaskRequest[];
  changedRequests: TaskRequest[];
  writes: TaskRequestFileWrite[];
  deletedPaths: [];
}

export function planTaskRequestChange(
  state: TaskRequestLifecycleState,
  operation: TaskRequestLifecycleOperation,
): TaskRequestChangePlan {
  const current = normalizeState(state);
  requireMutableTask(current.taskCard);
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
      return invalid("Task request lifecycle operation is not supported.");
  }
}

export function listTaskRequests(state: TaskRequestLifecycleState): TaskRequest[] {
  return normalizeState(state).requests.map(cloneRequest);
}

export function readTaskRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
): TaskRequest {
  return cloneRequest(requireRequest(normalizeState(state).requests, requestId));
}

function createRequest(
  state: TaskRequestLifecycleState,
  operation: Extract<TaskRequestLifecycleOperation, { kind: "create" }>,
): TaskRequestChangePlan {
  if (operation.activate) requireActiveTask(state.taskCard);
  if (operation.source === "agent_proposal" && operation.activate) {
    invalid("Agent proposals must begin queued and cannot be activated implicitly.");
  }
  if (operation.activate) requireNoActiveRequest(state.requests);
  const request: TaskRequest = {
    schema: "ayati.request/v1",
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
  renderTaskRequest(request);
  const taskCard = operation.activate
    ? activateTaskCard(state.taskCard, request)
    : cloneCard(state.taskCard);
  return buildPlan(state, "create", request.id, taskCard, [
    ...state.requests,
    request,
  ], [request], operation.activate ? request.id : undefined);
}

function activateRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
): TaskRequestChangePlan {
  requireActiveTask(state.taskCard);
  requireNoActiveRequest(state.requests);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "queued") {
    invalid("Only a queued request can be activated; blocked requests must be resumed.", {
      requestId,
      status: before.status,
    });
  }
  validateTaskRequestTransition({ from: before.status, to: "active" });
  const after = { ...cloneRequest(before), status: "active" as const };
  return buildPlan(
    state,
    "activate",
    requestId,
    activateTaskCard(state.taskCard, after),
    replaceRequest(state.requests, after),
    [after],
    requestId,
  );
}

function blockRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
  reason: string,
): TaskRequestChangePlan {
  requireActiveTask(state.taskCard);
  const before = requireCurrentRequest(state, requestId);
  validateTaskRequestTransition({ from: before.status, to: "blocked" });
  const normalizedReason = boundedLine(reason, "blocking reason", 400);
  const after: TaskRequest = {
    ...cloneRequest(before),
    status: "blocked",
    outcome: "Blocked: " + normalizedReason,
  };
  const taskCard = cloneCard(state.taskCard);
  taskCard.currentRequest = null;
  taskCard.currentFocus = "Resolve the blocker for " + requestId + ": " + before.title + ".";
  taskCard.blockers = withoutRequestBlocker(taskCard.blockers, requestId);
  taskCard.blockers.push(requestBlocker(requestId, normalizedReason));
  return buildPlan(state, "block", requestId, taskCard, replaceRequest(
    state.requests,
    after,
  ), [after]);
}

function resumeRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
): TaskRequestChangePlan {
  requireActiveTask(state.taskCard);
  requireNoActiveRequest(state.requests);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "blocked") {
    invalid("Only a blocked request can be resumed.", { requestId, status: before.status });
  }
  validateTaskRequestTransition({ from: before.status, to: "active" });
  const after: TaskRequest = {
    ...cloneRequest(before),
    status: "active",
    outcome: "Work resumed; completion is still pending.",
  };
  const taskCard = activateTaskCard(state.taskCard, after);
  taskCard.blockers = withoutRequestBlocker(taskCard.blockers, requestId);
  return buildPlan(
    state,
    "resume",
    requestId,
    taskCard,
    replaceRequest(state.requests, after),
    [after],
    requestId,
  );
}

function completeRequest(
  state: TaskRequestLifecycleState,
  operation: Extract<TaskRequestLifecycleOperation, { kind: "complete" }>,
): TaskRequestChangePlan {
  requireActiveTask(state.taskCard);
  const before = requireCurrentRequest(state, operation.requestId);
  if (operation.verification !== "verified" && operation.verification !== "user_accepted") {
    invalid("Completing a request requires deterministic verification or explicit user acceptance.");
  }
  validateTaskRequestTransition({ from: before.status, to: "done" });
  const after: TaskRequest = {
    ...cloneRequest(before),
    status: "done",
    outcome: boundedText(operation.outcome, "completion outcome", 2_000),
  };
  let requests = replaceRequest(state.requests, after);
  let taskCard = cloneCard(state.taskCard);
  taskCard.currentRequest = null;
  taskCard.currentFocus = "Choose or create the next request.";
  taskCard.blockers = withoutRequestBlocker(taskCard.blockers, operation.requestId);
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
    validateTaskRequestTransition({ from: next.status, to: "active" });
    const activated: TaskRequest = { ...cloneRequest(next), status: "active" };
    requests = replaceRequest(requests, activated);
    taskCard = activateTaskCard(taskCard, activated);
    changed.push(activated);
    activatedRequestId = activated.id;
  }
  return buildPlan(
    state,
    "complete",
    operation.requestId,
    taskCard,
    requests,
    changed,
    activatedRequestId,
    operation.verification,
  );
}

function dropRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
  reason: string,
): TaskRequestChangePlan {
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "queued" && before.status !== "active" && before.status !== "blocked") {
    invalid("Only a queued, active, or blocked request can be dropped.", {
      requestId,
      status: before.status,
    });
  }
  validateTaskRequestTransition({ from: before.status, to: "dropped" });
  const after: TaskRequest = {
    ...cloneRequest(before),
    status: "dropped",
    outcome: "Dropped: " + boundedLine(reason, "drop reason", 400),
  };
  const taskCard = cloneCard(state.taskCard);
  if (taskCard.currentRequest === requestId) {
    taskCard.currentRequest = null;
    taskCard.currentFocus = "Choose or create the next request.";
  }
  taskCard.blockers = withoutRequestBlocker(taskCard.blockers, requestId);
  return buildPlan(state, "drop", requestId, taskCard, replaceRequest(
    state.requests,
    after,
  ), [after]);
}

function reopenRequest(
  state: TaskRequestLifecycleState,
  operation: Extract<TaskRequestLifecycleOperation, { kind: "reopen" }>,
): TaskRequestChangePlan {
  requireActiveTask(state.taskCard);
  requireNoActiveRequest(state.requests);
  if (operation.explicitSameIntention !== true) {
    invalid("Reopening a completed request requires explicit same-intention confirmation.");
  }
  const before = requireRequest(state.requests, operation.requestId);
  validateTaskRequestTransition({
    from: before.status,
    to: "active",
    explicitReopen: operation.explicitSameIntention,
  });
  const after: TaskRequest = {
    ...cloneRequest(before),
    status: "active",
    outcome: "Reopened: " + boundedLine(operation.reason, "reopen reason", 400),
  };
  return buildPlan(
    state,
    "reopen",
    operation.requestId,
    activateTaskCard(state.taskCard, after),
    replaceRequest(state.requests, after),
    [after],
    after.id,
  );
}

function buildPlan(
  before: TaskRequestLifecycleState,
  operation: TaskRequestChangePlan["operation"],
  primaryRequestId: string,
  taskCard: TaskCard,
  requests: TaskRequest[],
  changedRequests: TaskRequest[],
  activatedRequestId?: string,
  completionVerification?: "verified" | "user_accepted",
): TaskRequestChangePlan {
  const after = normalizeState({
    expectedHead: before.expectedHead,
    taskCard,
    requests,
  });
  const taskCardBefore = cloneCard(before.taskCard);
  const taskCardAfter = cloneCard(after.taskCard);
  const taskCardChanged = renderTaskCard(taskCardBefore) !== renderTaskCard(taskCardAfter);
  const writes: TaskRequestFileWrite[] = changedRequests.map((request) => ({
    path: requestPath(request.id, request.title),
    content: renderTaskRequest(request),
  }));
  if (taskCardChanged) {
    writes.push({ path: TASK_CARD_PATH, content: renderTaskCard(taskCardAfter) });
  }
  writes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    operation,
    expectedHead: before.expectedHead,
    taskId: before.taskCard.id,
    primaryRequestId,
    ...(activatedRequestId ? { activatedRequestId } : {}),
    ...(completionVerification ? { completionVerification } : {}),
    taskCardBefore,
    taskCardAfter,
    requestsAfter: after.requests.map(cloneRequest),
    changedRequests: changedRequests.map(cloneRequest),
    writes,
    deletedPaths: [],
  };
}

function normalizeState(state: TaskRequestLifecycleState): TaskRequestLifecycleState {
  if (!/^[a-f0-9]{40,64}$/.test(state.expectedHead)) {
    invalid("Request planning requires a lowercase Git object identity as expected HEAD.");
  }
  const taskCard = cloneCard(state.taskCard);
  renderTaskCard(taskCard);
  const requests = state.requests.map(cloneRequest).sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const request of requests) {
    renderTaskRequest(request);
    if (seen.has(request.id)) invalid("Task request state contains duplicate identities.", {
      requestId: request.id,
    });
    seen.add(request.id);
  }
  const active = requests.filter((request) => request.status === "active");
  if (active.length > 1) {
    invalid("Task request state contains more than one active request.", {
      activeRequestIds: active.map((request) => request.id),
    });
  }
  if (taskCard.status !== "active" && active.length > 0) {
    invalid("Paused or archived tasks cannot contain an active request.");
  }
  const activeId = active[0]?.id ?? null;
  if (taskCard.currentRequest !== activeId) {
    invalid("Task card current_request must match the one active request or be none.", {
      currentRequest: taskCard.currentRequest,
      activeRequestId: activeId,
    });
  }
  return { expectedHead: state.expectedHead, taskCard, requests };
}

function requireMutableTask(taskCard: TaskCard): void {
  if (taskCard.status === "archived") {
    invalid("Archived tasks must be explicitly reopened before changing requests.");
  }
}

function requireActiveTask(taskCard: TaskCard): void {
  if (taskCard.status !== "active") {
    invalid("A request can become active only inside an active task.", {
      taskStatus: taskCard.status,
    });
  }
}

function requireNoActiveRequest(requests: TaskRequest[]): void {
  const active = requests.find((request) => request.status === "active");
  if (active) invalid("Another request is already active.", { activeRequestId: active.id });
}

function requireCurrentRequest(
  state: TaskRequestLifecycleState,
  requestId: string,
): TaskRequest {
  const request = requireRequest(state.requests, requestId);
  if (request.status !== "active" || state.taskCard.currentRequest !== requestId) {
    invalid("Operation requires the task's current active request.", {
      requestId,
      status: request.status,
      currentRequest: state.taskCard.currentRequest,
    });
  }
  return request;
}

function requireRequest(requests: TaskRequest[], requestId: string): TaskRequest {
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) invalid("Task request does not exist.", { requestId });
  return request;
}

function activateTaskCard(taskCard: TaskCard, request: TaskRequest): TaskCard {
  const result = cloneCard(taskCard);
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

function replaceRequest(requests: TaskRequest[], replacement: TaskRequest): TaskRequest[] {
  return requests.map((request) => request.id === replacement.id
    ? cloneRequest(replacement)
    : cloneRequest(request));
}

function cloneCard(card: TaskCard): TaskCard {
  return {
    ...card,
    blockers: [...card.blockers],
    importantPaths: card.importantPaths.map((entry) => ({ ...entry })),
    workingAgreements: [...card.workingAgreements],
  };
}

function cloneRequest(request: TaskRequest): TaskRequest {
  return {
    ...request,
    acceptance: [...request.acceptance],
    constraints: [...request.constraints],
  };
}

function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    invalid("Task request field is empty or exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    invalid("Task request field is empty or exceeds its size limit.", { field, maximum });
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new GitContextServiceError({
    code: "TASK_REQUEST_STATE_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
