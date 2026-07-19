import { createHash } from "node:crypto";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ContextSessionRunCheckpoint } from "../../context-engine/index.js";

export type TimelineContinuityCheckpoint = Omit<ContextSessionRunCheckpoint, "runId">;

export type ExactTimelineEvent =
  | {
      kind: "user";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "assistant";
      seq: number;
      timestamp: string;
      content: string;
      responseKind?: string;
      expectsUserResponse?: boolean;
      current?: true;
    }
  | {
      kind: "system";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "system_event";
      seq: number;
      timestamp: string;
      source: string;
      event: string;
      summary: string;
      current?: true;
    };

export interface TimelineCheckpointStatement {
  seq: number;
  text: string;
}

export interface TimelineCheckpointSummary {
  userRequests: TimelineCheckpointStatement[];
  constraints: TimelineCheckpointStatement[];
  decisions: TimelineCheckpointStatement[];
  corrections: TimelineCheckpointStatement[];
  importantFacts: TimelineCheckpointStatement[];
  unresolvedQuestions: TimelineCheckpointStatement[];
  references: TimelineCheckpointStatement[];
  narrative: string;
}

const CHECKPOINT_STATEMENT_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", minimum: 1 },
    text: { type: "string", minLength: 1 },
  },
  required: ["seq", "text"],
  additionalProperties: false,
};

export const TIMELINE_CHECKPOINT_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    userRequests: checkpointStatementArraySchema(),
    constraints: checkpointStatementArraySchema(),
    decisions: checkpointStatementArraySchema(),
    corrections: checkpointStatementArraySchema(),
    importantFacts: checkpointStatementArraySchema(),
    unresolvedQuestions: checkpointStatementArraySchema(),
    references: checkpointStatementArraySchema(),
    narrative: { type: "string", minLength: 1 },
  },
  required: [
    "userRequests",
    "constraints",
    "decisions",
    "corrections",
    "importantFacts",
    "unresolvedQuestions",
    "references",
    "narrative",
  ],
  additionalProperties: false,
};

export interface TimelineCheckpointEvent {
  kind: "checkpoint";
  seq: number;
  timestamp: string;
  current?: never;
  schemaVersion: 1;
  coveredFromSeq: number;
  coveredToSeq: number;
  sourceEventCount: number;
  sourceHash: string;
  summary: TimelineCheckpointSummary;
}

export type TimelineEvent = ExactTimelineEvent | TimelineCheckpointEvent;

export interface TimelineCheckpointPlan {
  schemaVersion: 1;
  triggered: boolean;
  requiredSavingsTokens: number;
  estimatedCheckpointTokens: number;
  selectedEventTokens: number;
  selectedSourceTokens: number;
  estimatedSavingsTokens: number;
  canReachTarget: boolean;
  selectedEvents: ExactTimelineEvent[];
  continuityCheckpoint?: TimelineContinuityCheckpoint;
  exactTail: ExactTimelineEvent[];
  protectedEvents: Array<{
    seq: number;
    kind: ExactTimelineEvent["kind"];
    reasons: Array<"current_input" | "answered_question" | "minimum_exact_tail">;
  }>;
  coveredFromSeq?: number;
  coveredToSeq?: number;
  sourceHash?: string;
}

const MINIMUM_EXACT_TAIL_EVENTS = 4;
const DEFAULT_CHECKPOINT_ESTIMATE_TOKENS = 1_200;

export function planTimelineCheckpoint(input: {
  events: ExactTimelineEvent[];
  continuityCheckpoint?: ContextSessionRunCheckpoint | TimelineContinuityCheckpoint;
  requiredSavingsTokens: number;
  estimatedCheckpointTokens?: number;
}): TimelineCheckpointPlan {
  const continuityCheckpoint = input.continuityCheckpoint
    ? withoutRunId(input.continuityCheckpoint)
    : undefined;
  const requiredSavingsTokens = Math.max(0, Math.ceil(input.requiredSavingsTokens));
  const estimatedCheckpointTokens = Math.max(
    1,
    Math.ceil(input.estimatedCheckpointTokens ?? DEFAULT_CHECKPOINT_ESTIMATE_TOKENS),
  );
  const protectedEvents = identifyProtectedEvents(input.events);
  const protectedIndexes = new Set(protectedEvents.map((entry) => entry.index));
  const continuityCheckpointTokens = continuityCheckpoint
    ? estimateTextTokens(JSON.stringify(continuityCheckpoint))
    : 0;
  let maximumPrefixCount = Math.max(0, input.events.length - MINIMUM_EXACT_TAIL_EVENTS);
  const firstProtectedIndex = [...protectedIndexes].sort((left, right) => left - right)[0];
  if (firstProtectedIndex !== undefined) {
    maximumPrefixCount = Math.min(maximumPrefixCount, firstProtectedIndex);
  }

  if (requiredSavingsTokens === 0 || (maximumPrefixCount === 0 && !continuityCheckpoint)) {
    return emptyPlan(
      input.events,
      requiredSavingsTokens,
      estimatedCheckpointTokens,
      protectedEvents,
      continuityCheckpoint,
    );
  }

  let selectedEventTokens = 0;
  let selectedCount = 0;
  let selectedSourceTokens = continuityCheckpointTokens;
  while (
    selectedCount < maximumPrefixCount
    && (selectedCount === 0 || selectedSourceTokens - estimatedCheckpointTokens < requiredSavingsTokens)
  ) {
    selectedEventTokens += estimateTimelineEventTokens(input.events[selectedCount]!);
    selectedSourceTokens = continuityCheckpointTokens + selectedEventTokens;
    selectedCount++;
    if (selectedSourceTokens - estimatedCheckpointTokens >= requiredSavingsTokens) {
      break;
    }
  }

  if (selectedSourceTokens <= estimatedCheckpointTokens) {
    return emptyPlan(
      input.events,
      requiredSavingsTokens,
      estimatedCheckpointTokens,
      protectedEvents,
      continuityCheckpoint,
    );
  }

  const selectedEvents = input.events.slice(0, selectedCount);
  const exactTail = input.events.slice(selectedCount);
  const estimatedSavingsTokens = selectedSourceTokens - estimatedCheckpointTokens;
  const coveredFromSeq = continuityCheckpoint?.fromSeq ?? selectedEvents[0]?.seq;
  const coveredToSeq = selectedEvents.at(-1)?.seq ?? continuityCheckpoint?.toSeq;
  return {
    schemaVersion: 1,
    triggered: true,
    requiredSavingsTokens,
    estimatedCheckpointTokens,
    selectedEventTokens,
    selectedSourceTokens,
    estimatedSavingsTokens,
    canReachTarget: estimatedSavingsTokens >= requiredSavingsTokens,
    selectedEvents,
    ...(continuityCheckpoint ? { continuityCheckpoint } : {}),
    exactTail,
    protectedEvents: protectedEvents.map(({ index: _index, ...entry }) => entry),
    coveredFromSeq,
    coveredToSeq,
    sourceHash: hashTimelineSource(continuityCheckpoint, selectedEvents),
  };
}

export function validateTimelineCheckpointAgainstPlan(
  checkpoint: TimelineCheckpointEvent,
  plan: TimelineCheckpointPlan,
): string[] {
  const errors: string[] = [];
  if (!plan.triggered || !plan.sourceHash) {
    return ["checkpoint plan does not contain a selected source range"];
  }
  if (checkpoint.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (checkpoint.coveredFromSeq !== plan.coveredFromSeq) errors.push("coveredFromSeq does not match the plan");
  if (checkpoint.coveredToSeq !== plan.coveredToSeq) errors.push("coveredToSeq does not match the plan");
  const sourceEventCount = plan.selectedEvents.length + (plan.continuityCheckpoint ? 1 : 0);
  if (checkpoint.sourceEventCount !== sourceEventCount) errors.push("sourceEventCount does not match the plan");
  if (checkpoint.sourceHash !== plan.sourceHash) errors.push("sourceHash does not match the plan");
  if (checkpoint.seq !== checkpoint.coveredToSeq) errors.push("checkpoint seq must equal coveredToSeq");
  if (!checkpoint.summary.narrative.trim()) errors.push("summary narrative must not be empty");

  const sourceSeqs = new Set(plan.selectedEvents.map((event) => event.seq));
  const statements = [
    ...checkpoint.summary.userRequests,
    ...checkpoint.summary.constraints,
    ...checkpoint.summary.decisions,
    ...checkpoint.summary.corrections,
    ...checkpoint.summary.importantFacts,
    ...checkpoint.summary.unresolvedQuestions,
    ...checkpoint.summary.references,
  ];
  for (const statement of statements) {
    if (!statement.text.trim()) errors.push(`checkpoint statement at seq ${statement.seq} is empty`);
    const fromContinuityCheckpoint = plan.continuityCheckpoint
      && statement.seq >= plan.continuityCheckpoint.fromSeq
      && statement.seq <= plan.continuityCheckpoint.toSeq;
    if (!sourceSeqs.has(statement.seq) && !fromContinuityCheckpoint) {
      errors.push(`checkpoint statement seq ${statement.seq} is not in the selected source events`);
    }
  }
  return [...new Set(errors)];
}

function identifyProtectedEvents(events: ExactTimelineEvent[]): Array<{
  index: number;
  seq: number;
  kind: ExactTimelineEvent["kind"];
  reasons: Array<"current_input" | "answered_question" | "minimum_exact_tail">;
}> {
  const reasons = new Map<number, Set<"current_input" | "answered_question" | "minimum_exact_tail">>();
  const protect = (
    index: number,
    reason: "current_input" | "answered_question" | "minimum_exact_tail",
  ): void => {
    const current = reasons.get(index) ?? new Set();
    current.add(reason);
    reasons.set(index, current);
  };
  const tailStart = Math.max(0, events.length - MINIMUM_EXACT_TAIL_EVENTS);
  for (let index = tailStart; index < events.length; index++) protect(index, "minimum_exact_tail");

  const currentIndex = events.findIndex((event) => event.current === true);
  if (currentIndex >= 0) {
    protect(currentIndex, "current_input");
    for (let index = currentIndex - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === "assistant" && event.expectsUserResponse === true) {
        protect(index, "answered_question");
        break;
      }
    }
  }

  return [...reasons.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, entryReasons]) => ({
      index,
      seq: events[index]!.seq,
      kind: events[index]!.kind,
      reasons: [...entryReasons],
    }));
}

function checkpointStatementArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: CHECKPOINT_STATEMENT_SCHEMA,
    maxItems: 64,
  };
}

function emptyPlan(
  events: ExactTimelineEvent[],
  requiredSavingsTokens: number,
  estimatedCheckpointTokens: number,
  protectedEvents: ReturnType<typeof identifyProtectedEvents>,
  continuityCheckpoint?: TimelineContinuityCheckpoint,
): TimelineCheckpointPlan {
  return {
    schemaVersion: 1,
    triggered: false,
    requiredSavingsTokens,
    estimatedCheckpointTokens,
    selectedEventTokens: 0,
    selectedSourceTokens: 0,
    estimatedSavingsTokens: 0,
    canReachTarget: requiredSavingsTokens === 0,
    selectedEvents: [],
    ...(continuityCheckpoint ? { continuityCheckpoint } : {}),
    exactTail: events,
    protectedEvents: protectedEvents.map(({ index: _index, ...entry }) => entry),
  };
}

function hashTimelineSource(
  continuityCheckpoint: TimelineContinuityCheckpoint | undefined,
  events: ExactTimelineEvent[],
): string {
  return createHash("sha256").update(JSON.stringify({
    continuityCheckpoint: continuityCheckpoint ?? null,
    events,
  })).digest("hex");
}

function withoutRunId(
  checkpoint: ContextSessionRunCheckpoint | TimelineContinuityCheckpoint,
): TimelineContinuityCheckpoint {
  const { runId: _runId, ...projected } = checkpoint as ContextSessionRunCheckpoint;
  return projected;
}

function estimateTimelineEventTokens(event: ExactTimelineEvent): number {
  return estimateTextTokens(JSON.stringify(event));
}
