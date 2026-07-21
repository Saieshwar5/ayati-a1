import { describe, expect, it } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  StreamMessage,
} from "ayati-context-engine";
import { buildPersonalMemoryCheckpointPayload } from "../../src/app/memory-runtime.js";

describe("personal-memory checkpoint extraction", () => {
  it("uses only the newly selected exact user and assistant message range", () => {
    const selectedMessages = [
      message(5, "system_event", "Background event."),
      message(6, "user", "Please remember that I prefer concise reports."),
      message(7, "assistant", "I will keep reports concise."),
    ];
    const payload = buildPersonalMemoryCheckpointPayload({
      userId: "local",
      streamId: "AST-LOCAL",
      plan: checkpointPlan(selectedMessages),
      checkpoint: checkpointRecord(),
    });

    expect(payload).toEqual({
      userId: "local",
      sessionId: "AST-LOCAL",
      sessionPath: "agent-stream:AST-LOCAL",
      checkpointId: "CHK-SECOND",
      coveredFromSeq: 6,
      coveredToSeq: 7,
      reason: "context_pressure_checkpoint",
      turns: [
        {
          role: "user",
          content: "Please remember that I prefer concise reports.",
          timestamp: "2026-07-20T10:06:00.000Z",
          sessionPath: "agent-stream:AST-LOCAL",
          workRunId: "RUN-6",
        },
        {
          role: "assistant",
          content: "I will keep reports concise.",
          timestamp: "2026-07-20T10:07:00.000Z",
          sessionPath: "agent-stream:AST-LOCAL",
          workRunId: "RUN-7",
        },
      ],
    });
    expect(payload).not.toHaveProperty("handoffSummary");
  });

  it("does not enqueue personal-memory work for a system-only checkpoint range", () => {
    expect(buildPersonalMemoryCheckpointPayload({
      userId: "local",
      streamId: "AST-LOCAL",
      plan: checkpointPlan([message(8, "system_event", "Internal state changed.")]),
      checkpoint: checkpointRecord(),
    })).toBeUndefined();
  });
});

function message(
  sequence: number,
  role: StreamMessage["role"],
  content: string,
): StreamMessage {
  return {
    messageId: `MSG-${sequence}`,
    streamId: "AST-LOCAL",
    runId: `RUN-${sequence}`,
    sequence,
    role,
    content,
    contentHash: `sha256:${sequence}`,
    at: `2026-07-20T10:0${sequence}:00.000Z`,
  };
}

function checkpointPlan(selectedMessages: StreamMessage[]): ContextCheckpointPlan {
  return {
    planId: "CPPLAN-SECOND",
    streamId: "AST-LOCAL",
    selectedMessages,
    exactTail: [],
    coveredFromSeq: 1,
    coveredToSeq: selectedMessages.at(-1)?.sequence,
    sourceHash: "sha256:source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function checkpointRecord(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-SECOND",
    streamId: "AST-LOCAL",
    previousCheckpointId: "CHK-FIRST",
    coveredFromSeq: 1,
    coveredToSeq: 7,
    sourceHash: "sha256:source",
    schemaVersion: 1,
    summary: {
      userRequests: [],
      constraints: [],
      decisions: [],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "This cumulative narrative also includes the first checkpoint.",
    },
    exactAnchors: [],
    tokenCount: 100,
    reason: "context_pressure",
    provider: "test",
    model: "test",
    createdAt: "2026-07-20T10:08:00.000Z",
  };
}
