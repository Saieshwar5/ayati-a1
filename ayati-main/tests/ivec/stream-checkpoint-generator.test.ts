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
      expect.objectContaining({
        attempt: 1,
        status: "success",
        providerCalled: true,
        errors: [],
      }),
    ]);
    expect(result.generationMethod).toBe("model");
    expect(result.tokenCount).toBeGreaterThan(0);
    const request = generateTurn.mock.calls[0]?.[0];
    expect(request?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "agent_stream_checkpoint_summary",
      strict: true,
    });
    expect(request?.maxOutputTokens).toBe(1_200);
    const sourceContent = request?.messages[1]?.content;
    if (typeof sourceContent !== "string") throw new Error("Checkpoint source prompt is missing.");
    const source = JSON.parse(sourceContent) as {
      messagesToSummarize: Array<{
        seq: number;
        responseKind?: string;
        feedbackKind?: string;
        attachmentRefs?: Array<{ resourceId: string }>;
      }>;
      protectedRecentContext: Array<{ seq: number }>;
    };
    expect(source.messagesToSummarize.map((message) => message.seq)).toEqual([2, 3]);
    expect(source.messagesToSummarize[0]?.attachmentRefs).toEqual([{
      resourceId: "RES-0123456789ABCDEF01234567",
      kind: "document",
      displayName: "context-plan.md",
    }]);
    expect(source.messagesToSummarize[1]).toMatchObject({
      responseKind: "feedback",
      feedbackKind: "confirmation",
    });
    expect(source.protectedRecentContext.map((message) => message.seq)).toEqual([4]);
    expect(request?.messages[0]?.content).toContain("Forget first:");
    expect(request?.messages[0]?.content).toContain("newer user correction overrides");
    expect(JSON.stringify(request?.messages)).not.toContain("toolCalls");
    expect(JSON.stringify(request?.messages)).not.toContain("workState");
  });

  it("uses deterministic fallback after one invalid anchored response", async () => {
    const invalid = validSummary();
    invalid.importantFacts = [{ seq: 99, text: "This anchor does not exist." }];
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(invalid) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("deterministic_fallback");
    expect(result.recoveryReason).toContain("sequence 99 is not an exact source anchor");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed"]);
    expect(result.summary?.importantFacts.some((fact) => fact.seq === 99)).toBe(false);
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("does not allow the protected exact tail to become a checkpoint anchor", async () => {
    const invalid = validSummary();
    invalid.importantFacts = [{ seq: 4, text: "Protected current context must remain exact." }];
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(invalid) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("deterministic_fallback");
    expect(result.recoveryReason).toContain("sequence 4 is not an exact source anchor");
    expect(result.summary?.importantFacts.some((fact) => fact.seq === 4)).toBe(false);
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic fallback after one malformed response", async () => {
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: "not json" },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("deterministic_fallback");
    expect(result.recoveryReason).toContain("checkpoint response is not valid JSON");
    expect(result.attempts).toHaveLength(1);
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("deterministically fits an oversized valid model checkpoint", async () => {
    const plan = checkpointPlan();
    plan.estimatedCheckpointTokens = 200;
    const oversized = validSummary();
    oversized.constraints = Array.from({ length: 12 }, (_, index) => ({
      seq: 2,
      text: `Constraint ${index + 1}: ${"preserve this bounded context ".repeat(20)}`,
    }));
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(oversized) },
    ]);

    const result = await generateStreamCheckpoint({ provider, plan });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("model_fitted");
    expect(result.modelTokenCount).toBeGreaterThan(200);
    expect(result.tokenCount).toBeLessThanOrEqual(200);
    expect(result.attempts).toHaveLength(1);
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(generateTurn.mock.calls[0]?.[0].maxOutputTokens).toBe(200);
  });

  it("honors a stricter recovery ceiling without another provider call", async () => {
    const oversized = validSummary();
    oversized.constraints = Array.from({ length: 12 }, (_, index) => ({
      seq: 2,
      text: `Constraint ${index + 1}: ${"retain this context ".repeat(20)}`,
    }));
    const { provider, generateTurn } = providerWith([
      { type: "assistant", content: JSON.stringify(oversized) },
    ]);

    const result = await generateStreamCheckpoint({
      provider,
      plan: checkpointPlan(),
      maximumSummaryTokens: 200,
    });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("model_fitted");
    expect(result.tokenCount).toBeLessThanOrEqual(200);
    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(generateTurn.mock.calls[0]?.[0].maxOutputTokens).toBe(200);
  });

  it("falls back locally when provider generation fails", async () => {
    const { provider, generateTurn } = providerWith([]);

    const result = await generateStreamCheckpoint({ provider, plan: checkpointPlan() });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("deterministic_fallback");
    expect(result.attempts).toEqual([
      expect.objectContaining({ status: "failed", providerCalled: true }),
    ]);
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("falls back without calling the provider when source input exceeds capacity", async () => {
    const { provider, generateTurn } = providerWith([]);

    const result = await generateStreamCheckpoint({
      provider,
      plan: checkpointPlan(),
      maxInputTokens: 1,
    });

    expect(result.status).toBe("success");
    expect(result.generationMethod).toBe("deterministic_fallback");
    expect(result.attempts).toEqual([
      expect.objectContaining({ status: "failed", providerCalled: false }),
    ]);
    expect(generateTurn).not.toHaveBeenCalled();
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
      message(2, "user", "Keep user messages and system events in the stream.", {
        attachmentRefs: [{
          resourceId: "RES-0123456789ABCDEF01234567",
          kind: "document",
          displayName: "context-plan.md",
        }],
      }),
      message(3, "assistant", "Should I separate stream continuity from run state?", {
        responseKind: "feedback",
        feedbackKind: "confirmation",
      }),
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
  metadata: Pick<
    StreamMessage,
    "responseKind" | "feedbackKind" | "attachmentRefs"
  > = {},
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
    ...(metadata.responseKind ? { responseKind: metadata.responseKind } : {}),
    ...(metadata.feedbackKind ? { feedbackKind: metadata.feedbackKind } : {}),
    ...(metadata.attachmentRefs ? { attachmentRefs: metadata.attachmentRefs } : {}),
  };
}
