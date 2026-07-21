import { describe, expect, it, vi } from "vitest";
import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
  ContextCheckpointSummary,
  StreamMessage,
} from "ayati-context-engine";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { generateStreamCheckpoint } from "../../src/ivec/agent-runner/stream-checkpoint-generator.js";

const AT = "2026-07-19T10:00:00.000Z";

describe("generateStreamCheckpoint", () => {
  it("refuses plans that were not selected by durable context pressure", async () => {
    const { provider, generateTurn } = providerWith([]);
    const plan = checkpointPlan();
    plan.triggered = false;

    const result = await generateStreamCheckpoint({ provider, plan });

    expect(result).toMatchObject({
      status: "failed",
      attempts: [],
      errors: ["checkpoint plan does not contain a pressure-selected source range"],
    });
    expect(generateTurn).not.toHaveBeenCalled();
  });

  it("creates a bounded structured checkpoint with exact source anchors", async () => {
    const summary = validSummary();
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(summary) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.summary).toEqual(summary);
    expect(result.attempts).toEqual([
      expect.objectContaining({ attempt: 1, status: "success", errors: [] }),
    ]);
    expect(result.tokenCount).toBeGreaterThan(0);
    const request = generateTurn.mock.calls[0]?.[0];
    expect(request?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "agent_stream_checkpoint_summary",
      strict: true,
    });
    const sourceContent = request?.messages[1]?.content;
    if (typeof sourceContent !== "string") throw new Error("Checkpoint source prompt is missing.");
    const source = JSON.parse(sourceContent) as { messages: Array<{ seq: number }> };
    expect(source.messages.map((message) => message.seq)).toEqual([2, 3]);
    expect(JSON.stringify(request?.messages)).not.toContain("toolCalls");
    expect(JSON.stringify(request?.messages)).not.toContain("workState");
  });

  it("uses its single repair attempt when a statement cites a non-source sequence", async () => {
    const invalid = validSummary();
    invalid.importantFacts = [{ seq: 99, text: "This anchor does not exist." }];
    const repaired = validSummary();
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(invalid) },
      { type: "assistant", content: JSON.stringify(repaired) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "success"]);
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairPrompt = generateTurn.mock.calls[1]?.[0].messages[0]?.content;
    expect(repairPrompt).toContain("Repair these validation failures");
    expect(repairPrompt).toContain("sequence 99 is not an exact source anchor");
  });

  it("stops after two failed generations", async () => {
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: "not json" },
      { type: "assistant", content: "still not json" },
      { type: "assistant", content: JSON.stringify(validSummary()) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("failed");
    expect(result.attempts).toHaveLength(2);
    expect(result.errors).toContain("checkpoint response is not valid JSON");
    expect(generateTurn).toHaveBeenCalledTimes(2);
  });
});

function providerWith(outputs: LlmTurnOutput[]): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
} {
  const queue = [...outputs];
  const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => {
    const output = queue.shift();
    if (!output) throw new Error("No checkpoint response queued.");
    return output;
  });
  return {
    generateTurn,
    provider: {
      name: "test-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: false,
        structuredOutput: { jsonObject: true, jsonSchema: true },
      },
      start() {},
      stop() {},
      generateTurn,
    },
  };
}

function checkpointPlan(): ContextCheckpointPlan {
  return {
    planId: "PLAN-1",
    streamId: "S-1",
    previousCheckpoint: previousCheckpoint(),
    selectedMessages: [
      message(2, "user", "Keep user messages and system events in the stream."),
      message(3, "assistant", "I will separate stream continuity from run state."),
    ],
    exactTail: [message(4, "user", "Implement the plan.")],
    coveredFromSeq: 1,
    coveredToSeq: 3,
    sourceHash: "sha256:source",
    estimatedCheckpointTokens: 1_200,
    triggered: true,
  };
}

function previousCheckpoint(): ContextCheckpointRecord {
  return {
    checkpointId: "CHK-previous",
    streamId: "S-1",
    coveredFromSeq: 1,
    coveredToSeq: 1,
    sourceHash: "sha256:previous",
    schemaVersion: 1,
    summary: {
      userRequests: [{ seq: 1, text: "Redesign the agent-facing context." }],
      constraints: [],
      decisions: [],
      corrections: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
      narrative: "The user requested a clearer context architecture.",
    },
    exactAnchors: [1],
    tokenCount: 100,
    reason: "context_pressure",
    provider: "test-provider",
    model: "test-model",
    createdAt: AT,
  };
}

function validSummary(): ContextCheckpointSummary {
  return {
    userRequests: [{ seq: 1, text: "Redesign the agent-facing context." }],
    constraints: [{ seq: 2, text: "Keep conversational messages in the stream." }],
    decisions: [{ seq: 3, text: "Separate stream continuity from run state." }],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: "The context redesign separates slow continuity from fast execution state.",
  };
}

function message(
  sequence: number,
  role: StreamMessage["role"],
  content: string,
): StreamMessage {
  return {
    messageId: `M-${sequence}`,
    streamId: "S-1",
    runId: "RUN-1",
    sequence,
    role,
    content,
    contentHash: `sha256:${sequence}`,
    at: `2026-07-19T10:00:0${sequence}.000Z`,
  };
}
