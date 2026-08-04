import type { ContextCheckpointRecord } from "ayati-context-engine";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ContextCurrentRouting } from "../../context-engine/index.js";
import {
  MAX_ACTIVE_DOCUMENTS,
  type ActiveDocumentPointer,
} from "../recent-document-registry.js";
import type { AgentTemporalEvent, AgentTemporalExactEvent } from "./agent-context-events.js";
import type { PromptFocusedWorkstreamContext } from "./focused-workstream-prompt-context.js";

export const CORE_CAPSULE_CONTINUITY_MAX_TOKENS = 8_000;

export type CoreCapsuleCheckpoint = Pick<
  ContextCheckpointRecord,
  "coveredFromSeq" | "coveredToSeq" | "summary" | "exactAnchors" | "createdAt"
>;

export interface CoreCapsuleUnloadedRange {
  fromSeq: number;
  toSeq: number;
  eventCount: number;
  sourceRef: string;
  reason: "continuity_budget";
}

export interface CoreCapsule {
  schemaVersion: 1;
  revision: string;
  current: {
    runId: string;
    input: AgentTemporalExactEvent;
    routing?: Pick<ContextCurrentRouting, "status" | "workstreamId" | "requestId">;
    activeDocuments?: ActiveDocumentPointer[];
  };
  focusedWorkstream?: PromptFocusedWorkstreamContext;
  continuity: {
    checkpoint?: CoreCapsuleCheckpoint;
    recentExact: AgentTemporalEvent[];
    unloadedRanges: CoreCapsuleUnloadedRange[];
    maintenanceRequired: boolean;
  };
  budget: {
    continuityMaxTokens: number;
    estimatedContinuityTokens: number;
  };
}

export interface BuildCoreCapsuleInput {
  revision: string;
  runId: string;
  timeline: AgentTemporalEvent[];
  checkpoint?: CoreCapsuleCheckpoint;
  routing?: ContextCurrentRouting;
  activeDocuments?: ActiveDocumentPointer[];
  focusedWorkstream?: PromptFocusedWorkstreamContext;
  continuityMaxTokens?: number;
}

export function buildCoreCapsule(input: BuildCoreCapsuleInput): CoreCapsule {
  const current = currentExactEvent(input.timeline);
  const history = input.timeline
    .filter((event): event is AgentTemporalEvent => !event.current)
    .sort((left, right) => left.seq - right.seq);
  const checkpoint = input.checkpoint ? checkpointForCapsule(input.checkpoint) : undefined;
  const continuityMaxTokens = Math.max(
    1,
    Math.trunc(input.continuityMaxTokens ?? CORE_CAPSULE_CONTINUITY_MAX_TOKENS),
  );
  const selected = selectRecentExactHistory({
    history,
    continuityMaxTokens,
    checkpoint,
  });
  const continuity = buildContinuity({
    checkpoint,
    recentExact: selected.events,
    omitted: selected.omitted,
  });
  const estimatedContinuityTokens = estimateTextTokens(JSON.stringify(continuity));
  return {
    schemaVersion: 1,
    revision: input.revision,
    current: {
      runId: input.runId,
      input: current,
      ...(input.routing ? {
        routing: {
          status: input.routing.status,
          ...(input.routing.workstreamId ? { workstreamId: input.routing.workstreamId } : {}),
          ...(input.routing.requestId ? { requestId: input.routing.requestId } : {}),
        },
      } : {}),
      ...(input.activeDocuments && input.activeDocuments.length > 0
        ? {
            activeDocuments: input.activeDocuments
              .slice(0, MAX_ACTIVE_DOCUMENTS)
              .map((document) => ({ ...document })),
          }
        : {}),
    },
    ...(input.focusedWorkstream ? { focusedWorkstream: input.focusedWorkstream } : {}),
    continuity,
    budget: {
      continuityMaxTokens,
      estimatedContinuityTokens,
    },
  };
}

export function replaceCoreCapsuleRecentExact(
  capsule: CoreCapsule,
  recentExact: AgentTemporalEvent[],
): CoreCapsule {
  if (recentExact.some((event) => event.current)) {
    throw new Error("CURRENT_INPUT_CONTEXT_MISMATCH: recent Core Capsule history cannot be current.");
  }
  const continuity = {
    ...capsule.continuity,
    recentExact: [...recentExact].sort((left, right) => left.seq - right.seq),
  };
  return {
    ...capsule,
    continuity,
    budget: {
      ...capsule.budget,
      estimatedContinuityTokens: estimateTextTokens(JSON.stringify(continuity)),
    },
  };
}

function currentExactEvent(timeline: AgentTemporalEvent[]): AgentTemporalExactEvent {
  const current = timeline.filter(
    (event): event is AgentTemporalExactEvent => event.current === true,
  );
  if (current.length !== 1) {
    throw new Error(
      "CURRENT_INPUT_CONTEXT_MISMATCH: the Core Capsule requires exactly one exact current input.",
    );
  }
  return current[0]!;
}

function checkpointForCapsule(checkpoint: CoreCapsuleCheckpoint): CoreCapsuleCheckpoint {
  return {
    coveredFromSeq: checkpoint.coveredFromSeq,
    coveredToSeq: checkpoint.coveredToSeq,
    summary: checkpoint.summary,
    exactAnchors: checkpoint.exactAnchors,
    createdAt: checkpoint.createdAt,
  };
}

function selectRecentExactHistory(
  input: {
    history: AgentTemporalEvent[];
    continuityMaxTokens: number;
    checkpoint: CoreCapsuleCheckpoint | undefined;
  },
): { events: AgentTemporalEvent[]; omitted: AgentTemporalEvent[] } {
  const groups = completeTurnGroups(input.history);
  const selectedGroups: AgentTemporalEvent[][] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    const candidateGroups = [group, ...selectedGroups];
    const candidateEvents = candidateGroups.flat();
    const candidateSequences = new Set(candidateEvents.map((event) => event.seq));
    const candidateContinuity = buildContinuity({
      checkpoint: input.checkpoint,
      recentExact: candidateEvents,
      omitted: input.history.filter((event) => !candidateSequences.has(event.seq)),
    });
    if (estimateTextTokens(JSON.stringify(candidateContinuity)) > input.continuityMaxTokens) {
      // The newest completed turn is the minimum exact continuity tail. It may
      // exceed the continuity target by itself; whole-request admission remains
      // the hard safety boundary for the provider request.
      if (selectedGroups.length === 0) selectedGroups.unshift(group);
      break;
    }
    selectedGroups.unshift(group);
  }
  const events = selectedGroups.flat();
  const selectedSequences = new Set(events.map((event) => event.seq));
  return {
    events,
    omitted: input.history.filter((event) => !selectedSequences.has(event.seq)),
  };
}

function buildContinuity(input: {
  checkpoint: CoreCapsuleCheckpoint | undefined;
  recentExact: AgentTemporalEvent[];
  omitted: AgentTemporalEvent[];
}): CoreCapsule["continuity"] {
  const unloadedRanges = buildUnloadedRanges(input.omitted);
  return {
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    recentExact: input.recentExact,
    unloadedRanges,
    maintenanceRequired: unloadedRanges.length > 0,
  };
}

function completeTurnGroups(events: AgentTemporalEvent[]): AgentTemporalEvent[][] {
  const groups: AgentTemporalEvent[][] = [];
  let current: AgentTemporalEvent[] = [];
  for (const event of events) {
    const startsTurn = event.kind !== "assistant";
    if (startsTurn && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildUnloadedRanges(events: AgentTemporalEvent[]): CoreCapsuleUnloadedRange[] {
  if (events.length === 0) return [];
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const ranges: CoreCapsuleUnloadedRange[] = [];
  let fromSeq = ordered[0]!.seq;
  let toSeq = fromSeq;
  let eventCount = 1;
  for (const event of ordered.slice(1)) {
    if (event.seq === toSeq + 1) {
      toSeq = event.seq;
      eventCount++;
      continue;
    }
    ranges.push(unloadedRange(fromSeq, toSeq, eventCount));
    fromSeq = event.seq;
    toSeq = event.seq;
    eventCount = 1;
  }
  ranges.push(unloadedRange(fromSeq, toSeq, eventCount));
  return ranges;
}

function unloadedRange(
  fromSeq: number,
  toSeq: number,
  eventCount: number,
): CoreCapsuleUnloadedRange {
  return {
    fromSeq,
    toSeq,
    eventCount,
    sourceRef: fromSeq === toSeq ? `seq:${fromSeq}` : `seq:${fromSeq}-${toSeq}`,
    reason: "continuity_budget",
  };
}
