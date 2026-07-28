import type { WorkstreamCard } from "./workstream-card.js";
import {
  nextRequestId,
  requestPath,
} from "./workstream-repository-layout.js";
import {
  normalizeWorkstreamRequest,
  renderWorkstreamRequest,
  type WorkstreamRequest,
  type WorkstreamRequestSource,
} from "./workstream-request.js";
import {
  activateWorkstreamCard,
  boundedLine,
  boundedText,
  buildLifecyclePlan as buildPlan,
  cloneCard,
  cloneRequest,
  inactiveWorkstreamCard,
  invalidRequestLifecycle as invalid,
  normalizeComparable,
  normalizeLifecycleState as normalizeState,
  replaceRequest,
  requestBlocker,
  requireActiveWorkstream,
  requireCurrentRequest,
  requireMutableWorkstream,
  requireNoActiveRequest,
  requireRequest,
  sameContract,
  transitionRequest as transition,
  transitionTime,
  withoutRequestBlocker,
} from "./workstream-request-lifecycle-state.js";

export interface WorkstreamRequestLifecycleState {
  expectedHead: string;
  workstreamCard: WorkstreamCard;
  requests: WorkstreamRequest[];
}

interface NewRequestContract {
  title: string;
  request: string;
  acceptance: string[];
  constraints: string[];
  source: WorkstreamRequestSource;
  createdAt: string;
}

export type WorkstreamRequestLifecycleOperation =
  | ({ kind: "create"; activate: boolean } & NewRequestContract)
  | { kind: "activate"; requestId: string; at?: string }
  | { kind: "defer"; requestId: string; reason: string; at?: string }
  | {
      kind: "defer_and_create";
      currentRequestId: string;
      deferReason: string;
      newRequest: NewRequestContract;
    }
  | {
      kind: "defer_and_activate";
      currentRequestId: string;
      nextRequestId: string;
      deferReason: string;
      at?: string;
    }
  | { kind: "block"; requestId: string; reason: string; at?: string }
  | { kind: "resume"; requestId: string; at?: string }
  | {
      kind: "resolve_blocked_to_queued";
      requestId: string;
      reason: string;
      at?: string;
    }
  | {
      kind: "amend";
      requestId: string;
      patch: {
        title?: string;
        request?: string;
        acceptance?: string[];
        constraints?: string[];
      };
      reason: string;
      authority: "user" | "trusted_policy";
      at?: string;
    }
  | {
      kind: "complete";
      requestId: string;
      outcome: string;
      verification: "verified" | "user_accepted";
      activateNextRequestId?: string;
      at?: string;
    }
  | { kind: "drop"; requestId: string; reason: string; at?: string };

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
  deferralReason?: string;
  completionVerification?: "verified" | "user_accepted";
  workstreamCardBefore: WorkstreamCard;
  workstreamCardAfter: WorkstreamCard;
  requestsBefore: WorkstreamRequest[];
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
      return activateRequest(current, operation.requestId, operation.at);
    case "defer":
      return deferRequest(current, operation.requestId, operation.reason, operation.at);
    case "defer_and_create":
      return deferAndCreateRequest(current, operation);
    case "defer_and_activate":
      return deferAndActivateRequest(current, operation);
    case "block":
      return blockRequest(current, operation.requestId, operation.reason, operation.at);
    case "resume":
      return resumeRequest(current, operation.requestId, operation.at);
    case "resolve_blocked_to_queued":
      return resolveBlockedRequest(current, operation);
    case "amend":
      return amendRequest(current, operation);
    case "complete":
      return completeRequest(current, operation);
    case "drop":
      return dropRequest(current, operation.requestId, operation.reason, operation.at);
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
  const id = nextRequestId(state.requests.map((entry) => entry.id));
  const request = newRequest(state.workstreamCard.id, id, operation, operation.activate);
  const card = operation.activate
    ? activateWorkstreamCard(state.workstreamCard, request)
    : cloneCard(state.workstreamCard);
  return buildPlan(
    state,
    "create",
    request.id,
    card,
    [...state.requests, request],
    [request],
    operation.activate ? request.id : undefined,
  );
}

function activateRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  suppliedAt?: string,
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
  const at = transitionTime(before, suppliedAt);
  const after = transition(before, "active", at, {
    lifecycleNote: "Activated for execution.",
    startedAt: before.startedAt ?? at,
  });
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

function deferRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  reason: string,
  suppliedAt?: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  const before = requireCurrentRequest(state, requestId);
  const normalizedReason = boundedLine(reason, "deferral reason", 500);
  const after = transition(before, "queued", transitionTime(before, suppliedAt), {
    lifecycleNote: "Deferred: " + normalizedReason,
  });
  const card = inactiveWorkstreamCard(
    state.workstreamCard,
    "Choose or create the next request. Deferred " + requestId + ": " + normalizedReason,
  );
  card.blockers = withoutRequestBlocker(card.blockers, requestId);
  const plan = buildPlan(
    state,
    "defer",
    requestId,
    card,
    replaceRequest(state.requests, after),
    [after],
  );
  return { ...plan, deferralReason: normalizedReason };
}

function deferAndCreateRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "defer_and_create" }>,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  if (operation.newRequest.source === "agent_proposal") {
    invalid("Agent proposals must begin queued and cannot be activated implicitly.");
  }
  const before = requireCurrentRequest(state, operation.currentRequestId);
  const reason = boundedLine(operation.deferReason, "deferral reason", 500);
  const deferred = transition(before, "queued", transitionTime(before, operation.newRequest.createdAt), {
    lifecycleNote: "Deferred: " + reason,
  });
  const id = nextRequestId(state.requests.map((request) => request.id));
  const created = newRequest(state.workstreamCard.id, id, operation.newRequest, true);
  const card = activateWorkstreamCard(state.workstreamCard, created);
  card.blockers = withoutRequestBlocker(card.blockers, operation.currentRequestId);
  const plan = buildPlan(
    state,
    "defer_and_create",
    operation.currentRequestId,
    card,
    [...replaceRequest(state.requests, deferred), created],
    [deferred, created],
    created.id,
  );
  return { ...plan, deferralReason: reason };
}

function deferAndActivateRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "defer_and_activate" }>,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  if (operation.currentRequestId === operation.nextRequestId) {
    invalid("The current and next request must be different.");
  }
  const current = requireCurrentRequest(state, operation.currentRequestId);
  const next = requireRequest(state.requests, operation.nextRequestId);
  if (next.status !== "queued") {
    invalid("Only a queued request can replace the current request.", {
      requestId: next.id,
      status: next.status,
    });
  }
  const reason = boundedLine(operation.deferReason, "deferral reason", 500);
  const at = transitionTime(current, operation.at);
  const deferred = transition(current, "queued", at, {
    lifecycleNote: "Deferred: " + reason,
  });
  const activated = transition(next, "active", transitionTime(next, at), {
    lifecycleNote: "Activated after deferring " + current.id + ".",
    startedAt: next.startedAt ?? at,
  });
  const requests = replaceRequest(replaceRequest(state.requests, deferred), activated);
  const card = activateWorkstreamCard(state.workstreamCard, activated);
  card.blockers = withoutRequestBlocker(card.blockers, current.id);
  const plan = buildPlan(
    state,
    "defer_and_activate",
    current.id,
    card,
    requests,
    [deferred, activated],
    activated.id,
  );
  return { ...plan, deferralReason: reason };
}

function blockRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  reason: string,
  suppliedAt?: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "active" && before.status !== "queued") {
    invalid("Only an active or queued request can become blocked.", {
      requestId,
      status: before.status,
    });
  }
  const normalizedReason = boundedLine(reason, "blocking reason", 480);
  const after = transition(before, "blocked", transitionTime(before, suppliedAt), {
    lifecycleNote: "Blocked: " + normalizedReason,
  });
  const card = cloneCard(state.workstreamCard);
  if (before.status === "active") {
    card.currentRequest = null;
    card.currentFocus = "Resolve the blocker for " + requestId + ": " + before.title + ".";
    card.nextAction = "Resolve the blocker for " + requestId + ".";
  }
  card.blockers = withoutRequestBlocker(card.blockers, requestId);
  card.blockers.push(requestBlocker(requestId, normalizedReason));
  return buildPlan(
    state,
    "block",
    requestId,
    card,
    replaceRequest(state.requests, after),
    [after],
  );
}

function resumeRequest(
  state: WorkstreamRequestLifecycleState,
  requestId: string,
  suppliedAt?: string,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  requireNoActiveRequest(state.requests);
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "blocked") {
    invalid("Only a blocked request can be resumed.", { requestId, status: before.status });
  }
  const at = transitionTime(before, suppliedAt);
  const after = transition(before, "active", at, {
    lifecycleNote: "Blocker resolved; request resumed.",
    startedAt: before.startedAt ?? at,
  });
  const card = activateWorkstreamCard(state.workstreamCard, after);
  card.blockers = withoutRequestBlocker(card.blockers, requestId);
  return buildPlan(
    state,
    "resume",
    requestId,
    card,
    replaceRequest(state.requests, after),
    [after],
    requestId,
  );
}

function resolveBlockedRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<
    WorkstreamRequestLifecycleOperation,
    { kind: "resolve_blocked_to_queued" }
  >,
): WorkstreamRequestChangePlan {
  const before = requireRequest(state.requests, operation.requestId);
  if (before.status !== "blocked") {
    invalid("Only a blocked request can be resolved to queued.", {
      requestId: before.id,
      status: before.status,
    });
  }
  const reason = boundedLine(operation.reason, "resolution reason", 500);
  const after = transition(before, "queued", transitionTime(before, operation.at), {
    lifecycleNote: "Blocker resolved; queued: " + reason,
  });
  const card = cloneCard(state.workstreamCard);
  card.blockers = withoutRequestBlocker(card.blockers, before.id);
  return buildPlan(
    state,
    "resolve_blocked_to_queued",
    before.id,
    card,
    replaceRequest(state.requests, after),
    [after],
  );
}

function amendRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "amend" }>,
): WorkstreamRequestChangePlan {
  const before = requireRequest(state.requests, operation.requestId);
  if (before.status === "done" || before.status === "dropped") {
    invalid("Done and dropped requests are terminal and cannot be amended.", {
      requestId: before.id,
      status: before.status,
    });
  }
  if (operation.authority === "trusted_policy" && operation.patch.acceptance) {
    const remaining = new Set(operation.patch.acceptance.map(normalizeComparable));
    const removed = before.acceptance.filter((criterion) => !remaining.has(
      normalizeComparable(criterion),
    ));
    if (removed.length > 0) {
      invalid("A policy amendment cannot weaken existing acceptance criteria.", {
        requestId: before.id,
        removed,
      });
    }
  }
  const reason = boundedLine(operation.reason, "amendment reason", 500);
  const after = normalizeWorkstreamRequest({
    ...cloneRequest(before),
    ...(operation.patch.title !== undefined ? { title: operation.patch.title } : {}),
    ...(operation.patch.request !== undefined ? { request: operation.patch.request } : {}),
    ...(operation.patch.acceptance !== undefined
      ? { acceptance: operation.patch.acceptance }
      : {}),
    ...(operation.patch.constraints !== undefined
      ? { constraints: operation.patch.constraints }
      : {}),
    updatedAt: transitionTime(before, operation.at),
    lifecycleNote: "Contract amended: " + reason,
  });
  if (sameContract(before, after)) {
    invalid("A request amendment must change at least one contract field.", {
      requestId: before.id,
    });
  }
  const card = before.status === "active"
    ? activateWorkstreamCard(state.workstreamCard, after)
    : cloneCard(state.workstreamCard);
  return buildPlan(
    state,
    "amend",
    before.id,
    card,
    replaceRequest(state.requests, after),
    [after],
    before.status === "active" ? before.id : undefined,
  );
}

function completeRequest(
  state: WorkstreamRequestLifecycleState,
  operation: Extract<WorkstreamRequestLifecycleOperation, { kind: "complete" }>,
): WorkstreamRequestChangePlan {
  requireActiveWorkstream(state.workstreamCard);
  const before = requireCurrentRequest(state, operation.requestId);
  const at = transitionTime(before, operation.at);
  const after = transition(before, "done", at, {
    lifecycleNote: "Completed with " + operation.verification + " evidence.",
    finalOutcome: boundedText(operation.outcome, "completion outcome", 2_000),
    closedAt: at,
  });
  let requests = replaceRequest(state.requests, after);
  let card = inactiveWorkstreamCard(state.workstreamCard, "Choose or create the next request.");
  card.blockers = withoutRequestBlocker(card.blockers, operation.requestId);
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
    const activated = transition(next, "active", transitionTime(next, at), {
      lifecycleNote: "Activated after completing " + operation.requestId + ".",
      startedAt: next.startedAt ?? at,
    });
    requests = replaceRequest(requests, activated);
    card = activateWorkstreamCard(card, activated);
    changed.push(activated);
    activatedRequestId = activated.id;
  }
  return buildPlan(
    state,
    "complete",
    operation.requestId,
    card,
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
  suppliedAt?: string,
): WorkstreamRequestChangePlan {
  const before = requireRequest(state.requests, requestId);
  if (before.status !== "queued" && before.status !== "active" && before.status !== "blocked") {
    invalid("Only a queued, active, or blocked request can be dropped.", {
      requestId,
      status: before.status,
    });
  }
  const at = transitionTime(before, suppliedAt);
  const after = transition(before, "dropped", at, {
    lifecycleNote: "Dropped: " + boundedLine(reason, "drop reason", 500),
    finalOutcome: "Dropped: " + boundedLine(reason, "drop reason", 500),
    closedAt: at,
  });
  const card = cloneCard(state.workstreamCard);
  if (card.currentRequest === requestId) {
    Object.assign(card, inactiveWorkstreamCard(card, "Choose or create the next request."));
  }
  card.blockers = withoutRequestBlocker(card.blockers, requestId);
  return buildPlan(
    state,
    "drop",
    requestId,
    card,
    replaceRequest(state.requests, after),
    [after],
  );
}

function newRequest(
  workstreamId: string,
  id: string,
  contract: NewRequestContract,
  active: boolean,
): WorkstreamRequest {
  const request = normalizeWorkstreamRequest({
    schema: "ayati.request/v3",
    id,
    workstreamId,
    relativePath: requestPath(id, contract.title),
    title: contract.title,
    status: active ? "active" : "queued",
    source: contract.source,
    createdAt: contract.createdAt,
    updatedAt: contract.createdAt,
    startedAt: active ? contract.createdAt : null,
    closedAt: null,
    request: contract.request,
    acceptance: [...contract.acceptance],
    constraints: [...contract.constraints],
    lifecycleNote: active ? "Created as the active request." : "Created as a queued request.",
    finalOutcome: "Pending.",
  });
  renderWorkstreamRequest(request);
  return request;
}
