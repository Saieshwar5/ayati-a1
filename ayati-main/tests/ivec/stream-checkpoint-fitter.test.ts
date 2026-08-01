import { describe, expect, it } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointSummary,
  StreamMessage,
} from "ayati-context-engine";
import {
  checkpointPlanAnchors,
  checkpointSummaryTokenCount,
  createDeterministicCheckpointFallback,
  fitCheckpointToBudget,
} from "../../src/ivec/agent-runner/stream-checkpoint-fitter.js";

describe("stream checkpoint deterministic fitting", () => {
  it("packs priority categories deterministically within the complete JSON budget", () => {
    const summary = emptySummary();
    summary.userRequests = [{ seq: 8, text: "Finish the current website request." }];
    summary.constraints = [{ seq: 7, text: "Use plain HTML, CSS, and JavaScript." }];
    summary.importantFacts = Array.from({ length: 40 }, (_, index) => ({
      seq: 6,
      text: `Optional historical fact ${index + 1}: ${"detail ".repeat(40)}`,
    }));
    const input = {
      summary,
      validAnchors: new Set([6, 7, 8]),
      maximumTokens: 200,
    };

    const first = fitCheckpointToBudget(input);
    const second = fitCheckpointToBudget(input);

    expect(first).toEqual(second);
    expect(first.tokenCount).toBe(checkpointSummaryTokenCount(first.summary));
    expect(first.tokenCount).toBeLessThanOrEqual(200);
    expect(first.summary.userRequests).toEqual([
      { seq: 8, text: "Finish the current website request." },
    ]);
    expect(first.summary.constraints).toEqual([
      { seq: 7, text: "Use plain HTML, CSS, and JavaScript." },
    ]);
    expect(first.droppedCounts.importantFacts).toBeGreaterThan(0);
  });

  it("removes invalid anchors and exact deterministic duplicates", () => {
    const summary = emptySummary();
    summary.decisions = [
      { seq: 4, text: "Keep the site dependency-free." },
      { seq: 4, text: "Keep   the site dependency-free." },
      { seq: 99, text: "Invented decision." },
    ];

    const fitted = fitCheckpointToBudget({
      summary,
      validAnchors: new Set([4]),
      maximumTokens: 1_200,
    });

    expect(fitted.summary.decisions).toEqual([
      { seq: 4, text: "Keep the site dependency-free." },
    ]);
    expect(JSON.stringify(fitted.summary)).not.toContain("Invented decision");
  });

  it("uses bounded exact excerpts and source pointers for essential oversized messages", () => {
    const summary = emptySummary();
    summary.userRequests = [{
      seq: 5,
      text: `Create the requested artifact. ${"🌿 preserve the exact requirement ".repeat(200)}`,
    }];

    const fitted = fitCheckpointToBudget({
      summary,
      validAnchors: new Set([5]),
      maximumTokens: 200,
    });

    expect(fitted.tokenCount).toBeLessThanOrEqual(200);
    expect(fitted.summary.userRequests).toHaveLength(1);
    expect(fitted.summary.userRequests[0]?.seq).toBe(5);
    expect(fitted.truncatedCounts.userRequests).toBeGreaterThan(0);
  });

  it("truncates Unicode statements within the UTF-16 character limit", () => {
    const summary = emptySummary();
    summary.importantFacts = [{
      seq: 5,
      text: `Observed result: ${"🌿".repeat(400)}`,
    }];

    const fitted = fitCheckpointToBudget({
      summary,
      validAnchors: new Set([5]),
      maximumTokens: 1_200,
    });

    expect(fitted.summary.importantFacts).toHaveLength(1);
    expect(fitted.summary.importantFacts[0]!.text.length).toBeLessThanOrEqual(320);
    expect(fitted.summary.importantFacts[0]!.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(fitted.summary.importantFacts[0]!.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
  });

  it("builds fallback only from the previous checkpoint and selected exact messages", () => {
    const plan = checkpointPlan();

    const fallback = createDeterministicCheckpointFallback({
      plan,
      maximumTokens: 1_200,
    });

    expect(fallback.tokenCount).toBeLessThanOrEqual(1_200);
    expect(fallback.summary.userRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ seq: 1 }),
      expect.objectContaining({ seq: 2, text: "Continue the context design." }),
    ]));
    expect(fallback.summary.unresolvedQuestions).toContainEqual({
      seq: 3,
      text: "Should I preserve exact history references?",
    });
    expect(fallback.summary.references[0]).toMatchObject({
      seq: 2,
      text: expect.stringContaining("design.md"),
    });
    expect(JSON.stringify(fallback.summary)).not.toContain("CURRENT EXACT TAIL");
    expect([...checkpointPlanAnchors(plan)]).toEqual([1, 2, 3]);
  });

  it("keeps assistant and system-event provenance explicit in fallback facts", () => {
    const plan = checkpointPlan();
    plan.selectedMessages.push(
      message(4, "system_event", "The provider connection was restored."),
      message(5, "assistant", "The website is complete."),
    );
    plan.coveredToSeq = 5;

    const fallback = createDeterministicCheckpointFallback({
      plan,
      maximumTokens: 1_200,
    });

    expect(fallback.summary.importantFacts).toEqual(expect.arrayContaining([
      { seq: 4, text: "System event: The provider connection was restored." },
      { seq: 5, text: "Assistant response: The website is complete." },
    ]));
  });

  it("fails explicitly when even the minimum schema cannot fit", () => {
    expect(() => fitCheckpointToBudget({
      summary: emptySummary(),
      validAnchors: new Set(),
      maximumTokens: 1,
    })).toThrow("cannot contain the minimum summary schema");
  });
});

function emptySummary(): ContextCheckpointSummary {
  return {
    userRequests: [],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "Earlier exact conversation remains available through history.",
  };
}

function checkpointPlan(): ContextCheckpointPlan {
  return {
    planId: "PLAN-1",
    streamId: "S-1",
    previousCheckpoint: {
      checkpointId: "CHK-1",
      streamId: "S-1",
      coveredFromSeq: 1,
      coveredToSeq: 1,
      sourceHash: "sha256:previous",
      schemaVersion: 1,
      summary: {
        ...emptySummary(),
        userRequests: [{ seq: 1, text: "Create a bounded context design." }],
      },
      exactAnchors: [1],
      tokenCount: 100,
      reason: "context_pressure",
      provider: "test",
      model: "test",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    selectedMessages: [
      message(2, "user", "Continue the context design.", {
        attachmentRefs: [{
          resourceId: "RES-0123456789ABCDEF01234567",
          kind: "document",
          displayName: "design.md",
        }],
      }),
      message(3, "assistant", "Should I preserve exact history references?", {
        responseKind: "feedback",
        feedbackKind: "confirmation",
      }),
    ],
    exactTail: [message(4, "user", "CURRENT EXACT TAIL")],
    coveredFromSeq: 1,
    coveredToSeq: 3,
    sourceHash: "sha256:source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function message(
  sequence: number,
  role: StreamMessage["role"],
  content: string,
  metadata: Pick<StreamMessage, "responseKind" | "feedbackKind" | "attachmentRefs"> = {},
): StreamMessage {
  return {
    messageId: `M-${sequence}`,
    streamId: "S-1",
    runId: `RUN-${sequence}`,
    sequence,
    role,
    content,
    contentHash: `sha256:${sequence}`,
    at: `2026-08-01T00:00:0${sequence}.000Z`,
    ...(metadata.responseKind ? { responseKind: metadata.responseKind } : {}),
    ...(metadata.feedbackKind ? { feedbackKind: metadata.feedbackKind } : {}),
    ...(metadata.attachmentRefs ? { attachmentRefs: metadata.attachmentRefs } : {}),
  };
}
