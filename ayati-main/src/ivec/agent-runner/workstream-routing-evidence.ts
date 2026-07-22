import type { LoopState, RunToolCallContext } from "../types.js";

const ROUTING_OBSERVATION_TOOLS = new Set([
  "git_context_find_workstreams",
  "git_context_read_workstream",
  "git_context_find_resources",
]);

export interface RoutingWorkstreamEvidence {
  workstreamId: string;
  head?: string;
  tier?: "candidate" | "probable" | "definite";
  reasons: string[];
  requestIds: string[];
  inspected: boolean;
  references: string[];
}

export interface RoutingResourceEvidence {
  resourceId: string;
  workstreamIds: string[];
  locators: string[];
  references: string[];
}

export interface WorkstreamRoutingEvidence {
  observed: boolean;
  workstreams: RoutingWorkstreamEvidence[];
  resources: RoutingResourceEvidence[];
  references: string[];
}

export function isWorkstreamRoutingObservationTool(toolName: string): boolean {
  return ROUTING_OBSERVATION_TOOLS.has(toolName);
}

export function collectWorkstreamRoutingEvidence(state: LoopState): WorkstreamRoutingEvidence {
  const workstreams = new Map<string, MutableWorkstreamEvidence>();
  const resources = new Map<string, MutableResourceEvidence>();
  const references = new Set<string>();
  let observed = false;

  for (const call of state.toolContext?.toolCalls ?? []) {
    if (call.status !== "success" || !isWorkstreamRoutingObservationTool(call.tool)) continue;
    if (call.stepRef?.runId && call.stepRef.runId !== state.runId) continue;
    observed = true;
    const reference = call.evidenceRef?.trim()
      || workstreamRoutingEvidenceReference(state.runId, call.step, call.callId);
    references.add(reference);
    const output = structuredCallOutput(call);
    if (call.tool === "git_context_find_workstreams") {
      collectCandidateArray(output["workstreams"], workstreams, reference, false);
    } else if (call.tool === "git_context_read_workstream") {
      collectReadWorkstream(output, workstreams, reference);
    } else if (call.tool === "git_context_find_resources") {
      collectResourceArray(output["resources"], resources, reference);
    }
  }

  return {
    observed,
    workstreams: [...workstreams.values()].map(freezeWorkstreamEvidence),
    resources: [...resources.values()].map(freezeResourceEvidence),
    references: [...references],
  };
}

interface MutableWorkstreamEvidence {
  workstreamId: string;
  head?: string;
  tier?: RoutingWorkstreamEvidence["tier"];
  reasons: Set<string>;
  requestIds: Set<string>;
  inspected: boolean;
  references: Set<string>;
}

interface MutableResourceEvidence {
  resourceId: string;
  workstreamIds: Set<string>;
  locators: Set<string>;
  references: Set<string>;
}

function collectCandidateArray(
  value: unknown,
  workstreams: Map<string, MutableWorkstreamEvidence>,
  reference: string,
  inspected: boolean,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = asRecord(item);
    const workstreamId = stringValue(record?.["workstreamId"]);
    if (!workstreamId) continue;
    const current = mutableWorkstream(workstreams, workstreamId);
    current.head = stringValue(record?.["head"]) ?? current.head;
    current.inspected ||= inspected;
    current.references.add(reference);
    const discovery = asRecord(record?.["discovery"]);
    const tier = discoveryTier(discovery?.["tier"]);
    if (tier) current.tier = tier;
    for (const reason of stringArray(discovery?.["reasons"])) current.reasons.add(reason);
    const request = asRecord(record?.["currentRequest"]);
    const requestId = stringValue(request?.["id"]);
    if (requestId) current.requestIds.add(requestId);
  }
}

function collectReadWorkstream(
  output: Record<string, unknown>,
  workstreams: Map<string, MutableWorkstreamEvidence>,
  reference: string,
): void {
  const workstream = asRecord(output["workstream"]);
  const workstreamId = stringValue(workstream?.["workstreamId"]);
  if (!workstreamId) return;
  const current = mutableWorkstream(workstreams, workstreamId);
  current.head = stringValue(workstream?.["head"]) ?? current.head;
  current.inspected = true;
  current.references.add(reference);
  current.reasons.add("inspected_workstream");
  const context = asRecord(output["context"]);
  const currentRequest = asRecord(context?.["currentRequest"]);
  const requestId = stringValue(currentRequest?.["id"]);
  if (requestId) current.requestIds.add(requestId);
}

function collectResourceArray(
  value: unknown,
  resources: Map<string, MutableResourceEvidence>,
  reference: string,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = asRecord(item);
    const resource = asRecord(record?.["resource"]);
    const resourceId = stringValue(resource?.["resourceId"]);
    if (!resourceId) continue;
    let current = resources.get(resourceId);
    if (!current) {
      current = {
        resourceId,
        workstreamIds: new Set(),
        locators: new Set(),
        references: new Set(),
      };
      resources.set(resourceId, current);
    }
    current.references.add(reference);
    for (const workstreamId of stringArray(record?.["workstreamIds"])) {
      current.workstreamIds.add(workstreamId);
    }
    const locator = resource?.["locator"];
    if (locator !== undefined) current.locators.add(stableLocator(locator));
  }
}

function mutableWorkstream(
  workstreams: Map<string, MutableWorkstreamEvidence>,
  workstreamId: string,
): MutableWorkstreamEvidence {
  const existing = workstreams.get(workstreamId);
  if (existing) return existing;
  const created: MutableWorkstreamEvidence = {
    workstreamId,
    reasons: new Set(),
    requestIds: new Set(),
    inspected: false,
    references: new Set(),
  };
  workstreams.set(workstreamId, created);
  return created;
}

function freezeWorkstreamEvidence(
  value: MutableWorkstreamEvidence,
): RoutingWorkstreamEvidence {
  return {
    workstreamId: value.workstreamId,
    ...(value.head ? { head: value.head } : {}),
    ...(value.tier ? { tier: value.tier } : {}),
    reasons: [...value.reasons],
    requestIds: [...value.requestIds],
    inspected: value.inspected,
    references: [...value.references],
  };
}

function freezeResourceEvidence(value: MutableResourceEvidence): RoutingResourceEvidence {
  return {
    resourceId: value.resourceId,
    workstreamIds: [...value.workstreamIds],
    locators: [...value.locators],
    references: [...value.references],
  };
}

function structuredCallOutput(call: RunToolCallContext): Record<string, unknown> {
  if (call.projectionMetadata) return call.projectionMetadata;
  try {
    return asRecord(JSON.parse(call.output)) ?? {};
  } catch {
    return {};
  }
}

export function workstreamRoutingEvidenceReference(
  runId: string,
  step: number,
  callId?: string,
): string {
  return [
    `run:${runId}`,
    `step:${step}`,
    ...(callId ? [`call:${callId}`] : []),
  ].join(":");
}

function stableLocator(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function discoveryTier(value: unknown): RoutingWorkstreamEvidence["tier"] | undefined {
  return value === "candidate" || value === "probable" || value === "definite"
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}
