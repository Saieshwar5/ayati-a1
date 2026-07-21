import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import { projectStateViewForStreamPressure } from "../agent-runner/stream-context-projection.js";
import { canonicalHash } from "./canonical.js";

export interface DeterministicReductionReceipt {
  removedDuplicateCount: number;
  removedInvalidObservationCount: number;
  removedCandidateCount: number;
  removedRecentWorkCount: number;
  removedResourceCount: number;
  removedObservationCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

export function applyDeterministicContextReduction(
  stateView: AgentPromptStateView,
  at: Date = new Date(),
): { stateView: AgentPromptStateView; receipt: DeterministicReductionReceipt } {
  const before = estimateStateTokens(stateView);
  const deduplicated = deduplicateState(stateView, at);
  const bounded = projectStateViewForStreamPressure(deduplicated.stateView, undefined);
  const contextBeforeBounds = deduplicated.stateView.context;
  const contextAfterBounds = bounded.context;
  const observationCountBefore = observationCount(contextBeforeBounds.observations);
  const observationCountAfter = observationCount(contextAfterBounds.observations);
  const after = estimateStateTokens(bounded);
  return {
    stateView: bounded,
    receipt: {
      removedDuplicateCount: deduplicated.removedDuplicateCount,
      removedInvalidObservationCount: deduplicated.removedInvalidObservationCount,
      removedCandidateCount: Math.max(0, contextBeforeBounds.work.candidates.length - contextAfterBounds.work.candidates.length),
      removedRecentWorkCount: Math.max(0, contextBeforeBounds.stream.recentWork.length - contextAfterBounds.stream.recentWork.length),
      removedResourceCount: Math.max(0, contextBeforeBounds.resources.stream.length - contextAfterBounds.resources.stream.length),
      removedObservationCount: Math.max(0, observationCountBefore - observationCountAfter),
      tokensBefore: before,
      tokensAfter: after,
    },
  };
}

export function removeDuplicateAndInvalidContext(
  stateView: AgentPromptStateView,
  at: Date = new Date(),
): {
  stateView: AgentPromptStateView;
  removedDuplicateCount: number;
  removedInvalidObservationCount: number;
} {
  return deduplicateState(stateView, at);
}

export function applyDeterministicContextBounds(
  stateView: AgentPromptStateView,
): {
  stateView: AgentPromptStateView;
  removedCandidateCount: number;
  removedRecentWorkCount: number;
  removedResourceCount: number;
  removedObservationCount: number;
} {
  const bounded = projectStateViewForStreamPressure(stateView, undefined);
  return {
    stateView: bounded,
    removedCandidateCount: Math.max(0, stateView.context.work.candidates.length - bounded.context.work.candidates.length),
    removedRecentWorkCount: Math.max(0, stateView.context.stream.recentWork.length - bounded.context.stream.recentWork.length),
    removedResourceCount: Math.max(0, stateView.context.resources.stream.length - bounded.context.resources.stream.length),
    removedObservationCount: Math.max(
      0,
      observationCount(stateView.context.observations) - observationCount(bounded.context.observations),
    ),
  };
}

function deduplicateState(
  stateView: AgentPromptStateView,
  at: Date,
): {
  stateView: AgentPromptStateView;
  removedDuplicateCount: number;
  removedInvalidObservationCount: number;
} {
  let removedDuplicateCount = 0;
  let removedInvalidObservationCount = 0;
  const temporal = uniqueBy(stateView.context.temporal.recent, (event) => `seq:${event.seq}`, (removed) => {
    removedDuplicateCount += removed;
  }, true);
  const recentWork = uniqueBy(stateView.context.stream.recentWork, stableRecentWorkId, (removed) => {
    removedDuplicateCount += removed;
  });
  const candidates = uniqueBy(stateView.context.work.candidates, stableWorkstreamId, (removed) => {
    removedDuplicateCount += removed;
  });
  const streamResources = uniqueBy(stateView.context.resources.stream, stableResourceId, (removed) => {
    removedDuplicateCount += removed;
  });
  const observations = {
    ...stateView.context.observations,
    inventory: cleanObservations(stateView.context.observations.inventory, at, (duplicates, invalid) => {
      removedDuplicateCount += duplicates;
      removedInvalidObservationCount += invalid;
    }),
    discovery: cleanObservations(stateView.context.observations.discovery, at, (duplicates, invalid) => {
      removedDuplicateCount += duplicates;
      removedInvalidObservationCount += invalid;
    }),
    evidence: cleanObservations(stateView.context.observations.evidence, at, (duplicates, invalid) => {
      removedDuplicateCount += duplicates;
      removedInvalidObservationCount += invalid;
    }),
  };
  return {
    stateView: {
      ...stateView,
      context: {
        ...stateView.context,
        temporal: { ...stateView.context.temporal, recent: temporal },
        stream: { ...stateView.context.stream, recentWork },
        work: { ...stateView.context.work, candidates },
        resources: { ...stateView.context.resources, stream: streamResources },
        observations,
      },
    },
    removedDuplicateCount,
    removedInvalidObservationCount,
  };
}

function cleanObservations<Value>(
  values: Value[],
  at: Date,
  onRemoved: (duplicates: number, invalid: number) => void,
): Value[] {
  const valid = values.filter((value) => {
    const record = asRecord(value);
    const expiresAt = typeof record?.["expiresAt"] === "string" ? Date.parse(record["expiresAt"]) : undefined;
    return typeof record?.["observationId"] === "string"
      && typeof record["preview"] === "string"
      && (expiresAt === undefined || (!Number.isNaN(expiresAt) && expiresAt > at.getTime()));
  });
  const unique = uniqueBy(valid, (value) => {
    const record = asRecord(value)!;
    return String(record["observationId"]);
  }, () => {});
  onRemoved(valid.length - unique.length, values.length - valid.length);
  return unique;
}

function uniqueBy<Value>(
  values: Value[],
  identity: (value: Value) => string,
  onRemoved: (removed: number) => void,
  preferCurrent = false,
): Value[] {
  const output: Value[] = [];
  const indexes = new Map<string, number>();
  for (const value of values) {
    const key = identity(value);
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, output.length);
      output.push(value);
      continue;
    }
    if (preferCurrent && asRecord(value)?.["current"] === true) output[existing] = value;
  }
  onRemoved(values.length - output.length);
  return output;
}

function stableRecentWorkId(value: unknown): string {
  const record = asRecord(value);
  return [record?.["workstreamId"], record?.["requestId"], record?.["completedAt"]]
    .filter(Boolean)
    .join(":") || canonicalHash(value);
}

function stableWorkstreamId(value: unknown): string {
  const id = asRecord(value)?.["workstreamId"];
  return typeof id === "string" ? id : canonicalHash(value);
}

function stableResourceId(value: unknown): string {
  const record = asRecord(value);
  const nested = asRecord(record?.["resource"]);
  const id = record?.["resourceId"] ?? nested?.["resourceId"];
  return typeof id === "string" ? id : canonicalHash(value);
}

function observationCount(input: {
  inventory: unknown[];
  discovery: unknown[];
  evidence: unknown[];
}): number {
  return input.inventory.length + input.discovery.length + input.evidence.length;
}

function estimateStateTokens(stateView: AgentPromptStateView): number {
  return estimateTextTokens(JSON.stringify(stateView));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
