import type { ResolutionDecisionContext } from "../workstream-resolution/decision.js";
import type { ResolutionStepHistory } from "../workstream-resolution/types.js";
import type { RunFocusSummary } from "./types.js";

export interface ResolverHistoryProjection {
  candidateIds: string[];
  ownershipIds: string[];
  requestIds: string[];
  heads: string[];
  descriptions: string[];
  evidenceRefs: string[];
}

export interface ResolverFocusOverlay {
  candidateId: string;
  summary: RunFocusSummary;
  coveredSourceRefs: string[];
  canonicalSourceHashes: Record<string, string>;
}

export interface ResolverProjectionReceipt {
  removedSuccessfulStepCount: number;
  projectedCandidateCount: number;
  projectedOwnershipCount: number;
  projectedRequestCount: number;
  projectedHeadCount: number;
  projectedDescriptionCount: number;
  projectedEvidenceCount: number;
}

export function applyResolverFocusOverlay(
  context: ResolutionDecisionContext,
  overlay: ResolverFocusOverlay | undefined,
): ResolutionDecisionContext {
  if (!overlay) return context;
  const covered = new Set(overlay.coveredSourceRefs);
  return {
    ...context,
    history: context.history.filter((step) => !covered.has(`resolver-step:${step.step}`)),
    focus: overlay.summary,
  };
}

export function projectResolverContext(
  context: ResolutionDecisionContext,
): { context: ResolutionDecisionContext; receipt: ResolverProjectionReceipt } {
  const latestStep = Math.max(0, ...context.history.map((step) => step.step));
  const hotFrom = Math.max(1, latestStep - 1);
  const exactHistory = context.history.filter((step) => {
    return step.step >= hotFrom || step.toolCalls.some((call) => call.status === "failed");
  });
  const olderSuccessful = context.history.filter((step) => {
    return step.step < hotFrom && step.toolCalls.every((call) => call.status === "completed");
  });
  const projectedHistory = mergeResolverHistoryProjection(
    context.projectedHistory,
    projectResolverHistory(olderSuccessful),
  );
  return {
    context: {
      ...context,
      initialCandidates: context.initialCandidates.slice(0, 5),
      state: {
        ...context.state,
        candidates: context.state.candidates.slice(0, 5),
        resourceOwnership: context.state.resourceOwnership.filter((result) => result.verified),
        failures: context.state.failures,
      },
      history: exactHistory,
      ...(hasProjection(projectedHistory) ? { projectedHistory } : {}),
    },
    receipt: {
      removedSuccessfulStepCount: olderSuccessful.length,
      projectedCandidateCount: projectedHistory.candidateIds.length,
      projectedOwnershipCount: projectedHistory.ownershipIds.length,
      projectedRequestCount: projectedHistory.requestIds.length,
      projectedHeadCount: projectedHistory.heads.length,
      projectedDescriptionCount: projectedHistory.descriptions.length,
      projectedEvidenceCount: projectedHistory.evidenceRefs.length,
    },
  };
}

export function projectResolverHistory(steps: ResolutionStepHistory[]): ResolverHistoryProjection {
  const projection = emptyProjection();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      collectTypedValues(call.output, projection);
      if (call.tool === "resolution_find_resource_owners") {
        for (const id of stringsAtKeys(call.output, new Set(["resourceId"]))) projection.ownershipIds.push(id);
      }
    }
  }
  return normalizeProjection(projection);
}

export function resolverStepProjection(step: ResolutionStepHistory): unknown {
  return {
    step: step.step,
    calls: step.toolCalls.map((call) => ({
      id: call.id,
      tool: call.tool,
      status: call.status,
      ...(call.status === "completed" ? { projection: projectResolverHistory([step]) } : {}),
      ...(call.error ? { error: call.error } : {}),
    })),
    verification: step.verification,
  };
}

function collectTypedValues(value: unknown, output: ResolverHistoryProjection): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTypedValues(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      if (key === "workstreamId" || key === "candidateId") output.candidateIds.push(item);
      else if (key === "resourceId" || key === "ownershipId") output.ownershipIds.push(item);
      else if (key === "requestId" || key === "id" && /^R-[0-9]{4}$/.test(item)) output.requestIds.push(item);
      else if (key === "head" || key === "expectedWorkstreamHead") output.heads.push(item);
      else if (key === "description" || key === "summary" || key === "title") output.descriptions.push(item);
      else if (/Ref$/.test(key) || key === "evidence") output.evidenceRefs.push(item);
    } else {
      collectTypedValues(item, output);
    }
  }
}

function stringsAtKeys(value: unknown, keys: Set<string>): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => stringsAtKeys(item, keys));
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) => {
    if (keys.has(key) && typeof item === "string") return [item];
    return stringsAtKeys(item, keys);
  });
}

function mergeResolverHistoryProjection(
  left: ResolverHistoryProjection | undefined,
  right: ResolverHistoryProjection,
): ResolverHistoryProjection {
  if (!left) return right;
  return normalizeProjection({
    candidateIds: [...left.candidateIds, ...right.candidateIds],
    ownershipIds: [...left.ownershipIds, ...right.ownershipIds],
    requestIds: [...left.requestIds, ...right.requestIds],
    heads: [...left.heads, ...right.heads],
    descriptions: [...left.descriptions, ...right.descriptions],
    evidenceRefs: [...left.evidenceRefs, ...right.evidenceRefs],
  });
}

function normalizeProjection(value: ResolverHistoryProjection): ResolverHistoryProjection {
  return {
    candidateIds: unique(value.candidateIds, 24),
    ownershipIds: unique(value.ownershipIds, 24),
    requestIds: unique(value.requestIds, 24),
    heads: unique(value.heads, 24),
    descriptions: unique(value.descriptions.map((description) => truncate(description, 500)), 24),
    evidenceRefs: unique(value.evidenceRefs, 32),
  };
}

function emptyProjection(): ResolverHistoryProjection {
  return {
    candidateIds: [],
    ownershipIds: [],
    requestIds: [],
    heads: [],
    descriptions: [],
    evidenceRefs: [],
  };
}

function hasProjection(value: ResolverHistoryProjection): boolean {
  return Object.values(value).some((items) => items.length > 0);
}

function unique(values: string[], maximum: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(-maximum);
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 3).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
