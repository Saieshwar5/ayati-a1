import { ContextEngineServiceError } from "../errors.js";
import {
  renderWorkstreamCard,
  type WorkstreamCard,
} from "./workstream-card.js";
import { WORKSTREAM_CARD_PATH } from "./workstream-repository-layout.js";
import {
  normalizeWorkstreamRequest,
  renderWorkstreamRequest,
  validateWorkstreamRequestTransition,
  type WorkstreamRequest,
} from "./workstream-request.js";
import type {
  WorkstreamRequestChangePlan,
  WorkstreamRequestFileWrite,
  WorkstreamRequestLifecycleState,
} from "./workstream-request-lifecycle.js";

export function buildLifecyclePlan(
  before: WorkstreamRequestLifecycleState,
  operation: WorkstreamRequestChangePlan["operation"],
  primaryRequestId: string,
  workstreamCard: WorkstreamCard,
  requests: WorkstreamRequest[],
  changedRequests: WorkstreamRequest[],
  activatedRequestId?: string,
  completionVerification?: "verified" | "user_accepted",
): WorkstreamRequestChangePlan {
  const after = normalizeLifecycleState({
    expectedHead: before.expectedHead,
    workstreamCard,
    requests,
  });
  const cardBefore = cloneCard(before.workstreamCard);
  const cardAfter = cloneCard(after.workstreamCard);
  const writes: WorkstreamRequestFileWrite[] = changedRequests.map((request) => ({
    path: request.relativePath,
    content: renderWorkstreamRequest(request),
  }));
  if (renderWorkstreamCard(cardBefore) !== renderWorkstreamCard(cardAfter)) {
    writes.push({ path: WORKSTREAM_CARD_PATH, content: renderWorkstreamCard(cardAfter) });
  }
  writes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    operation,
    expectedHead: before.expectedHead,
    workstreamId: before.workstreamCard.id,
    primaryRequestId,
    ...(activatedRequestId ? { activatedRequestId } : {}),
    ...(completionVerification ? { completionVerification } : {}),
    workstreamCardBefore: cardBefore,
    workstreamCardAfter: cardAfter,
    requestsBefore: before.requests.map(cloneRequest),
    requestsAfter: after.requests.map(cloneRequest),
    changedRequests: changedRequests.map(cloneRequest),
    writes,
    deletedPaths: [],
  };
}

export function normalizeLifecycleState(
  state: WorkstreamRequestLifecycleState,
): WorkstreamRequestLifecycleState {
  if (!/^[a-f0-9]{40,64}$/.test(state.expectedHead)) {
    invalidRequestLifecycle(
      "Request planning requires a lowercase Git object identity as expected HEAD.",
    );
  }
  const card = cloneCard(state.workstreamCard);
  renderWorkstreamCard(card);
  const requests = state.requests.map(cloneRequest).sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const seen = new Set<string>();
  for (const request of requests) {
    renderWorkstreamRequest(request);
    if (request.workstreamId !== card.id) {
      invalidRequestLifecycle("A request belongs to a different workstream.", {
        requestId: request.id,
        expectedWorkstreamId: card.id,
        actualWorkstreamId: request.workstreamId,
      });
    }
    if (seen.has(request.id)) {
      invalidRequestLifecycle("Workstream request state contains duplicate identities.", {
        requestId: request.id,
      });
    }
    seen.add(request.id);
  }
  const active = requests.filter((request) => request.status === "active");
  if (active.length > 1) {
    invalidRequestLifecycle("Workstream request state contains more than one active request.", {
      activeRequestIds: active.map((request) => request.id),
    });
  }
  if (card.status !== "active" && active.length > 0) {
    invalidRequestLifecycle("Paused or archived workstreams cannot contain an active request.");
  }
  const activeId = active[0]?.id ?? null;
  if (card.currentRequest !== activeId) {
    invalidRequestLifecycle(
      "Workstream card current_request must match the one active request or be none.",
      {
        currentRequest: card.currentRequest,
        activeRequestId: activeId,
      },
    );
  }
  return { expectedHead: state.expectedHead, workstreamCard: card, requests };
}

export function transitionRequest(
  before: WorkstreamRequest,
  status: WorkstreamRequest["status"],
  at: string,
  fields: Partial<Pick<
    WorkstreamRequest,
    "lifecycleNote" | "startedAt" | "closedAt" | "finalOutcome"
  >>,
): WorkstreamRequest {
  validateWorkstreamRequestTransition({ from: before.status, to: status });
  return normalizeWorkstreamRequest({
    ...cloneRequest(before),
    ...fields,
    status,
    updatedAt: at,
  });
}

export function requireMutableWorkstream(card: WorkstreamCard): void {
  if (card.status === "archived") {
    invalidRequestLifecycle(
      "Archived workstreams must be explicitly restored before changing requests.",
    );
  }
}

export function requireActiveWorkstream(card: WorkstreamCard): void {
  if (card.status !== "active") {
    invalidRequestLifecycle(
      "A request can become active only inside an active workstream.",
      { workstreamStatus: card.status },
    );
  }
}

export function requireNoActiveRequest(requests: WorkstreamRequest[]): void {
  const active = requests.find((request) => request.status === "active");
  if (active) {
    invalidRequestLifecycle("Another request is already active.", {
      activeRequestId: active.id,
    });
  }
}

export function requireCurrentRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
): WorkstreamRequest {
  const request = requireRequest(state.requests, requestId);
  if (request.status !== "active" || state.workstreamCard.currentRequest !== requestId) {
    invalidRequestLifecycle(
      "Operation requires the workstream's current active request.",
      {
        requestId,
        status: request.status,
        currentRequest: state.workstreamCard.currentRequest,
      },
    );
  }
  return request;
}

export function requireRequest(
  requests: WorkstreamRequest[],
  requestId: string,
): WorkstreamRequest {
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) {
    invalidRequestLifecycle("Workstream request does not exist.", { requestId });
  }
  return request;
}

export function transitionTime(request: WorkstreamRequest, supplied?: string): string {
  const at = supplied ?? request.updatedAt;
  if (!Number.isFinite(Date.parse(at))) {
    invalidRequestLifecycle("A lifecycle transition requires a valid timestamp.", { at });
  }
  if (Date.parse(at) < Date.parse(request.updatedAt)) {
    invalidRequestLifecycle("A lifecycle transition cannot precede the prior update.", {
      requestId: request.id,
      priorUpdatedAt: request.updatedAt,
      at,
    });
  }
  return at;
}

export function activateWorkstreamCard(
  card: WorkstreamCard,
  request: WorkstreamRequest,
): WorkstreamCard {
  const result = cloneCard(card);
  result.currentRequest = request.id;
  result.currentFocus = "Complete " + request.id + ": " + request.title + ".";
  result.nextAction = "Advance " + request.id + " toward its acceptance criteria.";
  return result;
}

export function inactiveWorkstreamCard(
  card: WorkstreamCard,
  focus: string,
): WorkstreamCard {
  const result = cloneCard(card);
  result.currentRequest = null;
  result.currentFocus = focus;
  result.nextAction = focus;
  return result;
}

export function requestBlocker(requestId: string, reason: string): string {
  return "Request " + requestId + ": " + reason;
}

export function withoutRequestBlocker(blockers: string[], requestId: string): string[] {
  const prefix = "Request " + requestId + ":";
  return blockers.filter((blocker) => !blocker.startsWith(prefix));
}

export function replaceRequest(
  requests: WorkstreamRequest[],
  replacement: WorkstreamRequest,
): WorkstreamRequest[] {
  return requests.map((request) => (
    request.id === replacement.id ? cloneRequest(replacement) : cloneRequest(request)
  ));
}

export function sameContract(
  left: WorkstreamRequest,
  right: WorkstreamRequest,
): boolean {
  return left.title === right.title
    && left.request === right.request
    && JSON.stringify(left.acceptance) === JSON.stringify(right.acceptance)
    && JSON.stringify(left.constraints) === JSON.stringify(right.constraints);
}

export function normalizeComparable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function cloneCard(card: WorkstreamCard): WorkstreamCard {
  return {
    ...card,
    aliases: [...card.aliases],
    importantFindings: [...card.importantFindings],
    decisions: [...card.decisions],
    openQuestions: [...card.openQuestions],
    blockers: [...card.blockers],
  };
}

export function cloneRequest(request: WorkstreamRequest): WorkstreamRequest {
  return {
    ...request,
    acceptance: [...request.acceptance],
    constraints: [...request.constraints],
  };
}

export function boundedLine(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum) {
    invalidRequestLifecycle(
      "Workstream request field is empty or exceeds its size limit.",
      { field, maximum },
    );
  }
  return normalized;
}

export function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    invalidRequestLifecycle(
      "Workstream request field is empty or exceeds its size limit.",
      { field, maximum },
    );
  }
  return normalized;
}

export function invalidRequestLifecycle(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REQUEST_STATE_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
