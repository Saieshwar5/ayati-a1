import type { WorkstreamCandidate } from "ayati-context-engine";
import type {
  ResolutionToolCallRecord,
  ResolutionWorkState,
} from "./types.js";

export function reduceResolutionWorkState(
  current: ResolutionWorkState,
  calls: ResolutionToolCallRecord[],
): ResolutionWorkState {
  const next = structuredClone(current);
  for (const call of calls) {
    if (call.status === "failed") {
      if (call.error) next.failures.push(call.error);
      next.nextOperation = "Repair the failed resolver call or choose a safe terminal outcome.";
      continue;
    }
    switch (call.tool) {
      case "resolution_search_workstreams":
        applySearch(next, call.output);
        break;
      case "resolution_read_workstreams":
        applyReads(next, call.output);
        break;
      case "resolution_find_resource_owners":
        applyOwners(next, call.output);
        break;
      case "resolution_inspect_resource":
        applyInspection(next, call.output);
        break;
      case "resolution_activate_workstream":
      case "resolution_create_workstream":
        next.status = "resolved";
        next.nextOperation = undefined;
        break;
      case "resolution_needs_user_input":
        next.status = "needs_user_input";
        next.nextOperation = undefined;
        break;
    }
  }
  if (next.status !== "resolved" && next.status !== "needs_user_input") {
    next.status = next.candidates.length > 0
      ? next.candidates.some((candidate) => candidate.inspected)
        ? "inspecting"
        : "candidates_found"
      : "searching";
  }
  next.candidates = next.candidates.slice(0, 12);
  next.failures = next.failures.slice(-8);
  return next;
}

function applySearch(state: ResolutionWorkState, output: unknown): void {
  const record = asRecord(output);
  const workstreams = Array.isArray(record?.["workstreams"])
    ? record["workstreams"]
    : [];
  for (const value of workstreams) {
    if (!isCandidate(value)) continue;
    mergeCandidate(state, value, false, value.currentRequest ? [value.currentRequest.id] : []);
  }
  state.searches.push({
    query: "authoritative workstream discovery",
    completed: true,
  });
  state.nextOperation = workstreams.length > 0
    ? "Read the strongest candidate before selecting it."
    : "Inspect resource ownership or create a new workstream if the task is concrete.";
}

function applyReads(state: ResolutionWorkState, output: unknown): void {
  const record = asRecord(output);
  const workstreams = Array.isArray(record?.["workstreams"])
    ? record["workstreams"]
    : [];
  for (const value of workstreams) {
    const read = asRecord(value);
    if (!read || read["status"] !== "completed") continue;
    const catalog = read["workstream"];
    const context = asRecord(read["context"]);
    const workstreamId = typeof read["workstreamId"] === "string"
      ? read["workstreamId"]
      : undefined;
    const existing = workstreamId
      ? state.candidates.find((candidate) => candidate.candidate.workstreamId === workstreamId)
      : undefined;
    if (existing) {
      existing.inspected = true;
      const request = asRecord(context?.["currentRequest"]);
      const requestId = typeof request?.["id"] === "string" ? request["id"] : undefined;
      existing.possibleRequestIds = requestId ? [requestId] : [];
      if (isCatalogHead(catalog)) existing.candidate.head = catalog.head;
      continue;
    }
    const candidate = workstreamId
      ? candidateFromRead(workstreamId, catalog, context)
      : undefined;
    if (!candidate) continue;
    mergeCandidate(
      state,
      candidate,
      true,
      candidate.currentRequest ? [candidate.currentRequest.id] : [],
    );
  }
  state.nextOperation = "Select a proven request route, inspect remaining ambiguity, or ask the user.";
}

function applyOwners(state: ResolutionWorkState, output: unknown): void {
  const record = asRecord(output);
  const resources = Array.isArray(record?.["resources"]) ? record["resources"] : [];
  for (const value of resources) {
    const resource = asRecord(value);
    if (!resource) continue;
    const ref = asRecord(resource["resource"]);
    const locator = ref ? JSON.stringify(ref["locator"] ?? ref["resourceId"] ?? "resource") : "resource";
    const workstreamIds = Array.isArray(resource["workstreamIds"])
      ? resource["workstreamIds"].filter((item): item is string => typeof item === "string")
      : [];
    state.resourceOwnership.push({ locator, workstreamIds, verified: true });
  }
  state.resourceOwnership = state.resourceOwnership.slice(-12);
  state.nextOperation = "Search or read the workstreams identified by resource ownership.";
}

function applyInspection(state: ResolutionWorkState, output: unknown): void {
  const record = asRecord(output);
  const resource = asRecord(record?.["resource"]);
  const locator = resource
    ? JSON.stringify(resource["locator"] ?? resource["resourceId"] ?? "resource")
    : "resource";
  state.resourceOwnership.push({ locator, workstreamIds: [], verified: false });
  state.resourceOwnership = state.resourceOwnership.slice(-12);
  state.nextOperation = "Find the inspected resource's owners before selecting or creating a workstream.";
}

function mergeCandidate(
  state: ResolutionWorkState,
  candidate: WorkstreamCandidate,
  inspected: boolean,
  possibleRequestIds: string[],
): void {
  const existing = state.candidates.find((item) => item.candidate.workstreamId === candidate.workstreamId);
  if (existing) {
    existing.candidate = candidate;
    existing.inspected ||= inspected;
    existing.possibleRequestIds = [...new Set([...existing.possibleRequestIds, ...possibleRequestIds])];
    return;
  }
  state.candidates.push({ candidate, inspected, possibleRequestIds });
}

function isCandidate(value: unknown): value is WorkstreamCandidate {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record["workstreamId"] === "string"
    && typeof record["title"] === "string"
    && typeof record["head"] === "string"
    && asRecord(record["discovery"]),
  );
}

function isCatalogHead(value: unknown): value is { head: string } {
  return Boolean(asRecord(value) && typeof (value as Record<string, unknown>)["head"] === "string");
}

function candidateFromRead(
  workstreamId: string,
  catalogValue: unknown,
  context: Record<string, unknown> | undefined,
): WorkstreamCandidate | undefined {
  const catalog = asRecord(catalogValue);
  if (
    !catalog
    || catalog["workstreamId"] !== workstreamId
    || typeof catalog["title"] !== "string"
    || typeof catalog["objective"] !== "string"
    || !isWorkstreamStatus(catalog["status"])
    || typeof catalog["head"] !== "string"
    || typeof catalog["updatedAt"] !== "string"
  ) {
    return undefined;
  }
  const currentRequest = requestSummary(context?.["currentRequest"]);
  const resources = Array.isArray(context?.["resources"])
    ? context["resources"]
    : [];
  const primaryResources = resources.flatMap((value) => {
    const binding = asRecord(value);
    const resource = asRecord(binding?.["resource"]);
    return binding?.["primary"] === true && resource
      ? [resource as unknown as WorkstreamCandidate["primaryResources"][number]]
      : [];
  });
  return {
    workstreamId,
    title: catalog["title"],
    objective: catalog["objective"],
    status: catalog["status"],
    ...(isLifecycleStatus(context?.["lifecycleStatus"])
      ? { lifecycleStatus: context["lifecycleStatus"] }
      : {}),
    ...(isRepositoryHealth(context?.["repositoryHealth"])
      ? { repositoryHealth: context["repositoryHealth"] }
      : {}),
    ...(currentRequest ? { currentRequest } : {}),
    head: catalog["head"],
    primaryResources,
    updatedAt: catalog["updatedAt"],
    discovery: {
      tier: "definite",
      reasons: ["exact_workstream_id"],
    },
    starred: false,
    boundRunsLast30Days: 0,
  };
}

function requestSummary(value: unknown): WorkstreamCandidate["currentRequest"] | undefined {
  const request = asRecord(value);
  return request
    && typeof request["id"] === "string"
    && typeof request["title"] === "string"
    && isRequestStatus(request["status"])
    ? {
        id: request["id"],
        title: request["title"],
        status: request["status"],
      }
    : undefined;
}

function isWorkstreamStatus(value: unknown): value is WorkstreamCandidate["status"] {
  return value === "initializing" || value === "active" || value === "archived";
}

function isLifecycleStatus(value: unknown): value is NonNullable<WorkstreamCandidate["lifecycleStatus"]> {
  return value === "active" || value === "paused" || value === "archived";
}

function isRepositoryHealth(value: unknown): value is NonNullable<WorkstreamCandidate["repositoryHealth"]> {
  return value === "ready" || value === "dirty_external" || value === "unavailable";
}

function isRequestStatus(
  value: unknown,
): value is NonNullable<WorkstreamCandidate["currentRequest"]>["status"] {
  return value === "queued"
    || value === "active"
    || value === "blocked"
    || value === "done"
    || value === "dropped";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
