import { createHash } from "node:crypto";
import { estimateTextTokens } from "../../prompt/token-estimator.js";

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
  estimatedSavingsTokens: number;
  canReachTarget: boolean;
  selectedEvents: ExactTimelineEvent[];
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
  requiredSavingsTokens: number;
  estimatedCheckpointTokens?: number;
}): TimelineCheckpointPlan {
  const requiredSavingsTokens = Math.max(0, Math.ceil(input.requiredSavingsTokens));
  const estimatedCheckpointTokens = Math.max(
    1,
    Math.ceil(input.estimatedCheckpointTokens ?? DEFAULT_CHECKPOINT_ESTIMATE_TOKENS),
  );
  const protectedEvents = identifyProtectedEvents(input.events);
  const protectedIndexes = new Set(protectedEvents.map((entry) => entry.index));
  let maximumPrefixCount = Math.max(0, input.events.length - MINIMUM_EXACT_TAIL_EVENTS);
  const firstProtectedIndex = [...protectedIndexes].sort((left, right) => left - right)[0];
  if (firstProtectedIndex !== undefined) {
    maximumPrefixCount = Math.min(maximumPrefixCount, firstProtectedIndex);
  }

  if (requiredSavingsTokens === 0 || maximumPrefixCount === 0) {
    return emptyPlan(input.events, requiredSavingsTokens, estimatedCheckpointTokens, protectedEvents);
  }

  let selectedEventTokens = 0;
  let selectedCount = 0;
  while (selectedCount < maximumPrefixCount) {
    selectedEventTokens += estimateTimelineEventTokens(input.events[selectedCount]!);
    selectedCount++;
    if (selectedEventTokens - estimatedCheckpointTokens >= requiredSavingsTokens) {
      break;
    }
  }

  if (selectedEventTokens <= estimatedCheckpointTokens) {
    return emptyPlan(input.events, requiredSavingsTokens, estimatedCheckpointTokens, protectedEvents);
  }

  const selectedEvents = input.events.slice(0, selectedCount);
  const exactTail = input.events.slice(selectedCount);
  const estimatedSavingsTokens = selectedEventTokens - estimatedCheckpointTokens;
  return {
    schemaVersion: 1,
    triggered: true,
    requiredSavingsTokens,
    estimatedCheckpointTokens,
    selectedEventTokens,
    estimatedSavingsTokens,
    canReachTarget: estimatedSavingsTokens >= requiredSavingsTokens,
    selectedEvents,
    exactTail,
    protectedEvents: protectedEvents.map(({ index: _index, ...entry }) => entry),
    coveredFromSeq: selectedEvents[0]!.seq,
    coveredToSeq: selectedEvents.at(-1)!.seq,
    sourceHash: hashTimelineEvents(selectedEvents),
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
  if (checkpoint.sourceEventCount !== plan.selectedEvents.length) errors.push("sourceEventCount does not match the plan");
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
    if (!sourceSeqs.has(statement.seq)) {
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
): TimelineCheckpointPlan {
  return {
    schemaVersion: 1,
    triggered: false,
    requiredSavingsTokens,
    estimatedCheckpointTokens,
    selectedEventTokens: 0,
    estimatedSavingsTokens: 0,
    canReachTarget: requiredSavingsTokens === 0,
    selectedEvents: [],
    exactTail: events,
    protectedEvents: protectedEvents.map(({ index: _index, ...entry }) => entry),
  };
}

function estimateTimelineEventTokens(event: ExactTimelineEvent): number {
  return estimateTextTokens(JSON.stringify(event));
}

function hashTimelineEvents(events: ExactTimelineEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}
