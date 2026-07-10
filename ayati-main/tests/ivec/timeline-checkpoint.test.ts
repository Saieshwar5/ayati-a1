import { describe, expect, it } from "vitest";
import {
  planTimelineCheckpoint,
  TIMELINE_CHECKPOINT_SUMMARY_SCHEMA,
  validateTimelineCheckpointAgainstPlan,
} from "../../src/ivec/agent-runner/timeline-checkpoint.js";
import type {
  ExactTimelineEvent,
  TimelineCheckpointEvent,
} from "../../src/ivec/agent-runner/timeline-checkpoint.js";

describe("timeline checkpoint planning", () => {
  it("publishes a strict structured summary schema", () => {
    expect(TIMELINE_CHECKPOINT_SUMMARY_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
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
    });
  });

  it("does not select timeline events when no savings are required", () => {
    const events = timelineEvents(8);
    const plan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 0,
    });

    expect(plan.triggered).toBe(false);
    expect(plan.selectedEvents).toEqual([]);
    expect(plan.exactTail).toEqual(events);
    expect(plan.canReachTarget).toBe(true);
  });

  it("selects only the oldest required prefix and protects the recent tail", () => {
    const events = timelineEvents(8, 8_000);
    const plan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 200,
    });

    expect(plan.triggered).toBe(true);
    expect(plan.selectedEvents.map((event) => event.seq)).toEqual([1]);
    expect(plan.exactTail.map((event) => event.seq)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(plan.protectedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ seq: 7, reasons: expect.arrayContaining(["answered_question", "minimum_exact_tail"]) }),
      expect.objectContaining({ seq: 8, reasons: expect.arrayContaining(["current_input", "minimum_exact_tail"]) }),
    ]));
    expect(plan.canReachTarget).toBe(true);
    expect(plan.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports when the complete eligible prefix cannot recover enough tokens", () => {
    const events = timelineEvents(8, 1_000);
    const plan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 20_000,
      estimatedCheckpointTokens: 100,
    });

    expect(plan.triggered).toBe(true);
    expect(plan.selectedEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(plan.exactTail.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
    expect(plan.canReachTarget).toBe(false);
  });

  it("combines the continuity checkpoint with at least one eligible timeline event", () => {
    const events = timelineEvents(8, 8_000).map((event) => ({
      ...event,
      seq: event.seq + 2,
    }));
    const continuityCheckpoint = {
      checkpointId: "checkpoint-1",
      commit: "commit-1",
      workId: "work-1",
      runId: "run-1",
      status: "completed" as const,
      fromSeq: 1,
      toSeq: 2,
      sourceHash: "a".repeat(64),
      strategy: "llm" as const,
      at: "2026-07-10T00:00:02.000Z",
      summary: `Previous task-run context: ${"x".repeat(8_000)}`,
    };
    const plan = planTimelineCheckpoint({
      events,
      continuityCheckpoint,
      requiredSavingsTokens: 100,
      estimatedCheckpointTokens: 200,
    });

    expect(plan.triggered).toBe(true);
    expect(plan.continuityCheckpoint).toEqual(continuityCheckpoint);
    expect(plan.selectedEvents.map((event) => event.seq)).toEqual([3]);
    expect(plan.coveredFromSeq).toBe(1);
    expect(plan.coveredToSeq).toBe(3);
    expect(plan.selectedSourceTokens).toBeGreaterThan(plan.selectedEventTokens);
    expect(validateTimelineCheckpointAgainstPlan(checkpointFor(plan), plan)).toEqual([]);
  });

  it("keeps an answered assistant question exact even when it is outside the minimum tail", () => {
    const events = timelineEvents(10, 8_000);
    events[3] = {
      kind: "assistant",
      seq: 4,
      timestamp: events[3]!.timestamp,
      content: "Which project should I update?",
      expectsUserResponse: true,
    };
    const laterQuestion = events[8]!;
    events[8] = {
      kind: "assistant",
      seq: laterQuestion.seq,
      timestamp: laterQuestion.timestamp,
      content: "Acknowledged.",
    };
    const plan = planTimelineCheckpoint({
      events,
      requiredSavingsTokens: 20_000,
      estimatedCheckpointTokens: 200,
    });

    expect(plan.selectedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(plan.exactTail[0]).toMatchObject({
      seq: 4,
      kind: "assistant",
      expectsUserResponse: true,
    });
    expect(plan.protectedEvents).toContainEqual(expect.objectContaining({
      seq: 4,
      reasons: expect.arrayContaining(["answered_question"]),
    }));
  });

  it("produces a stable source hash that changes with source content", () => {
    const first = planTimelineCheckpoint({
      events: timelineEvents(8, 8_000),
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 200,
    });
    const same = planTimelineCheckpoint({
      events: timelineEvents(8, 8_000),
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 200,
    });
    const changedEvents = timelineEvents(8, 8_000);
    changedEvents[0] = { ...changedEvents[0]!, content: "changed source content" } as ExactTimelineEvent;
    const changed = planTimelineCheckpoint({
      events: changedEvents,
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 200,
    });

    expect(first.sourceHash).toBe(same.sourceHash);
    expect(changed.sourceHash).not.toBe(first.sourceHash);
  });

  it("validates checkpoint coverage, source identity, and statement references", () => {
    const plan = planTimelineCheckpoint({
      events: timelineEvents(8, 8_000),
      requiredSavingsTokens: 1_000,
      estimatedCheckpointTokens: 200,
    });
    const checkpoint = checkpointFor(plan);

    expect(validateTimelineCheckpointAgainstPlan(checkpoint, plan)).toEqual([]);
    expect(validateTimelineCheckpointAgainstPlan({
      ...checkpoint,
      sourceHash: "wrong",
      summary: {
        ...checkpoint.summary,
        constraints: [{ seq: 999, text: "Invented reference" }],
      },
    }, plan)).toEqual(expect.arrayContaining([
      "sourceHash does not match the plan",
      "checkpoint statement seq 999 is not in the selected source events",
    ]));
  });
});

function timelineEvents(count: number, contentChars = 100): ExactTimelineEvent[] {
  return Array.from({ length: count }, (_, index): ExactTimelineEvent => {
    const seq = index + 1;
    if (seq === count) {
      return {
        kind: "user",
        seq,
        timestamp: `2026-07-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
        content: "yes",
        current: true,
      };
    }
    if (seq === count - 1) {
      return {
        kind: "assistant",
        seq,
        timestamp: `2026-07-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
        content: "Should I continue?",
        expectsUserResponse: true,
      };
    }
    return {
      kind: seq % 2 === 0 ? "assistant" : "user",
      seq,
      timestamp: `2026-07-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
      content: `${seq}:${"x".repeat(contentChars)}`,
    };
  });
}

function checkpointFor(
  plan: ReturnType<typeof planTimelineCheckpoint>,
): TimelineCheckpointEvent {
  const coveredFromSeq = plan.coveredFromSeq!;
  const coveredToSeq = plan.coveredToSeq!;
  return {
    kind: "checkpoint",
    seq: coveredToSeq,
    timestamp: plan.selectedEvents.at(-1)?.timestamp ?? plan.continuityCheckpoint!.at,
    schemaVersion: 1,
    coveredFromSeq,
    coveredToSeq,
    sourceEventCount: plan.selectedEvents.length + (plan.continuityCheckpoint ? 1 : 0),
    sourceHash: plan.sourceHash!,
    summary: {
      userRequests: [{ seq: coveredFromSeq, text: "Original request" }],
      constraints: [],
      decisions: [],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "The conversation established the original request.",
    },
  };
}
