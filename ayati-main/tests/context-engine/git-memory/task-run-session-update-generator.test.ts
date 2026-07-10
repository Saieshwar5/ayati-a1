import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../../src/core/contracts/provider.js";
import type {
  LlmTurnInput,
  LlmTurnOutput,
} from "../../../src/core/contracts/llm-protocol.js";
import {
  createTaskRunSessionUpdateCache,
  generateTaskRunSessionUpdate,
  planTaskRunCheckpoint,
  TASK_RUN_SESSION_UPDATE_SCHEMA,
} from "../../../src/context-engine/git-memory/index.js";
import type {
  GitMemoryConversationRecord,
  ReadyTaskRunCheckpointPlan,
  SessionSnapshot,
  TaskRunCheckpointPlan,
  TaskRunCheckpointRunSource,
  TaskRunCheckpointSessionInterval,
} from "../../../src/context-engine/git-memory/index.js";

describe("task-run session update generator", () => {
  it("generates a trusted combined update and reuses the success cache", async () => {
    const plan = checkpointPlan();
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validUpdate(plan)),
    }));
    const provider = createProvider(generateTurn);
    const cache = createTaskRunSessionUpdateCache();

    const generated = await generateTaskRunSessionUpdate({ provider, plan, cache });
    const cached = await generateTaskRunSessionUpdate({ provider, plan, cache });

    expect(generated).toMatchObject({
      status: "success",
      strategy: "llm",
      cacheStatus: "generated",
      summaryUpdated: true,
      checkpoint: {
        checkpointId: plan.checkpointId,
        coverage: plan.coverage,
        run: plan.run,
        recentExactConversation: plan.recentExactConversation,
      },
      sessionSnapshot: {
        recentProgress: [{ runId: plan.run.runId }],
      },
    });
    expect(cached).toMatchObject({
      status: "success",
      cacheStatus: "success_hit",
      attempts: [],
    });
    expect(generateTurn).toHaveBeenCalledTimes(1);
    const turnInput = generateTurn.mock.calls[0]?.[0];
    expect(turnInput?.tools).toBeUndefined();
    expect(turnInput?.responseFormat).toMatchObject({
      type: "json_schema",
      name: "task_run_session_update",
      strict: true,
    });
    expect(turnInput?.messages[1]?.content).toContain("conversationInterval");
    expect(generated.status === "success" && generated.summaryMarkdown).toContain("# Session Summary");
  });

  it("publishes a strict combined output schema", () => {
    expect(TASK_RUN_SESSION_UPDATE_SCHEMA).toMatchObject({
      type: "object",
      required: ["sessionInterval", "sessionSnapshot"],
      additionalProperties: false,
    });
  });

  it("repairs an invalid checkpoint statement reference once", async () => {
    const plan = checkpointPlan();
    const invalid = validUpdate(plan);
    invalid.sessionInterval.constraints = [{ seq: 999, text: "Invented constraint" }];
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(invalid) })
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(validUpdate(plan)) });

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(result.status).toBe("success");
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "success"]);
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[1]?.[0]?.messages[0]?.content).toContain(
      "checkpoint statement seq 999 is not in the covered conversation",
    );
    expect(generateTurn.mock.calls[1]?.[0]?.messages[1]?.content).toContain("invalidPreviousOutput");
  });

  it("repairs a syntactically valid but stale session snapshot", async () => {
    const plan = checkpointPlan();
    const stale = validUpdate(plan);
    stale.sessionSnapshot.recentProgress = [];
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(stale) })
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(validUpdate(plan)) });

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(result.status).toBe("success");
    expect(result.attempts[0]?.errors).toContain(
      `session snapshot must include recent progress for current run ${plan.run.runId}`,
    );
  });

  it("repairs an update that drops authoritative structured context", async () => {
    const plan = checkpointPlan();
    const repaired = validUpdate(plan);
    repaired.sessionInterval.decisions = [{ seq: 2, text: "Keep structured decisions exact" }];
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(validUpdate(plan)) })
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(repaired) });

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      structuredContext: { decisions: ["Keep structured decisions exact"] },
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(result.status).toBe("success");
    expect(result.attempts[0]?.errors).toContain(
      "sessionInterval must preserve structured decision: Keep structured decisions exact",
    );
  });

  it("repairs a session interval that rewrites the pending question", async () => {
    const plan = checkpointPlan({ status: "needs_user_input" });
    const invalid = validUpdate(plan);
    invalid.sessionInterval.unresolvedQuestions[0]!.text = "Which database?";
    const generateTurn = vi.fn()
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(invalid) })
      .mockResolvedValueOnce({ type: "assistant", content: JSON.stringify(validUpdate(plan)) });

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(result.status).toBe("success");
    expect(result.attempts[0]?.errors).toContain(
      "sessionInterval must preserve the exact pending user-input question and source sequence",
    );
    if (result.status === "success") {
      expect(result.checkpoint.pendingUserInput?.question).toBe(plan.pendingUserInput?.question);
    }
  });

  it("falls back deterministically, retains the previous summary, and negative-caches failure", async () => {
    const plan = checkpointPlan();
    const previousSummary = {
      text: "# Session Summary\n\nPrevious valid snapshot.",
      coveredUntilSeq: 0,
    };
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: "not-json",
    }));
    const provider = createProvider(generateTurn);
    const cache = createTaskRunSessionUpdateCache();

    const fallback = await generateTaskRunSessionUpdate({
      provider,
      plan,
      previousSummary,
      structuredContext: { decisions: ["Keep deterministic fallback"] },
      cache,
    });
    const cachedFallback = await generateTaskRunSessionUpdate({
      provider,
      plan,
      previousSummary,
      structuredContext: { decisions: ["Keep deterministic fallback"] },
      cache,
    });

    expect(fallback).toMatchObject({
      status: "fallback",
      strategy: "deterministic",
      cacheStatus: "generated",
      summaryUpdated: false,
      retainedSummary: previousSummary,
      checkpoint: {
        sessionInterval: {
          decisions: [{ text: "Keep deterministic fallback" }],
        },
      },
    });
    expect(cachedFallback).toMatchObject({
      status: "fallback",
      cacheStatus: "failure_hit",
      attempts: [],
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
    if (fallback.status === "fallback" && fallback.retainedSummary) {
      fallback.retainedSummary.text = "mutated result";
    }
    expect(previousSummary.text).toContain("Previous valid snapshot");
  });

  it("falls back after provider tool calls or exceptions", async () => {
    const plan = checkpointPlan();
    const toolProvider = createProvider(vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "tool_calls",
      calls: [{ id: "call-1", name: "unexpected", input: {} }],
    })));
    const throwingProvider = createProvider(vi.fn(async () => {
      throw new Error("provider unavailable");
    }));

    const toolResult = await generateTaskRunSessionUpdate({
      provider: toolProvider,
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });
    const thrownResult = await generateTaskRunSessionUpdate({
      provider: throwingProvider,
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(toolResult).toMatchObject({ status: "fallback", attempts: [{ status: "failed" }, { status: "failed" }] });
    expect(toolResult.errors).toContain("task-run session update provider returned tool calls instead of assistant JSON");
    expect(thrownResult).toMatchObject({ status: "fallback", attempts: [{ status: "failed" }, { status: "failed" }] });
    expect(thrownResult.errors).toContain("provider unavailable");
  });

  it("does not call the provider when generator input exceeds capacity", async () => {
    const plan = checkpointPlan();
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validUpdate(plan)),
    }));

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      cache: createTaskRunSessionUpdateCache(),
      maxGeneratorInputTokens: 100,
    });

    expect(result.status).toBe("fallback");
    expect(result.errors).toEqual([expect.stringContaining("task-run session update input requires")]);
    expect(generateTurn).not.toHaveBeenCalled();
  });

  it("falls back when checkpoint or rendered snapshot exceeds its budget", async () => {
    const checkpointPlanValue = checkpointPlan({ maxCheckpointTokens: 600 });
    const oversizedCheckpoint = validUpdate(checkpointPlanValue);
    oversizedCheckpoint.sessionInterval.summary = "x".repeat(8_000);
    const snapshotPlanValue = checkpointPlan();
    const oversizedSnapshot = validUpdate(snapshotPlanValue);
    oversizedSnapshot.sessionSnapshot.overview.summary = "x".repeat(8_000);

    const checkpointResult = await generateTaskRunSessionUpdate({
      provider: createProvider(vi.fn(async () => ({
        type: "assistant",
        content: JSON.stringify(oversizedCheckpoint),
      }))),
      plan: checkpointPlanValue,
      cache: createTaskRunSessionUpdateCache(),
    });
    const snapshotResult = await generateTaskRunSessionUpdate({
      provider: createProvider(vi.fn(async () => ({
        type: "assistant",
        content: JSON.stringify(oversizedSnapshot),
      }))),
      plan: snapshotPlanValue,
      cache: createTaskRunSessionUpdateCache(),
      maxSnapshotTokens: 500,
    });

    expect(checkpointResult.status).toBe("fallback");
    expect(checkpointResult.errors).toEqual([expect.stringContaining("checkpoint uses")]);
    expect(snapshotResult.status).toBe("fallback");
    expect(snapshotResult.errors).toEqual([expect.stringContaining("session snapshot uses")]);
  });

  it("separates cache entries by previous summary", async () => {
    const plan = checkpointPlan();
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validUpdate(plan)),
    }));
    const provider = createProvider(generateTurn);
    const cache = createTaskRunSessionUpdateCache();

    await generateTaskRunSessionUpdate({
      provider,
      plan,
      previousSummary: { text: "First summary" },
      cache,
    });
    await generateTaskRunSessionUpdate({
      provider,
      plan,
      previousSummary: { text: "Second summary" },
      cache,
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects mutated plan sources before reading or writing cache", async () => {
    const plan = checkpointPlan();
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: JSON.stringify(validUpdate(plan)),
    }));
    const provider = createProvider(generateTurn);
    const cache = createTaskRunSessionUpdateCache();
    const first = await generateTaskRunSessionUpdate({ provider, plan, cache });
    expect(first.status).toBe("success");
    plan.sourceRecords[0] = { ...plan.sourceRecords[0]!, text: "mutated after planning" };

    const mutated = await generateTaskRunSessionUpdate({ provider, plan, cache });

    expect(mutated.status).toBe("failed");
    expect(mutated.errors).toContain("plan source records no longer match the source hash");
    expect(generateTurn).toHaveBeenCalledTimes(1);
  });

  it("fails without calling the provider for a non-ready plan", async () => {
    const conversation = conversationRecords("completed");
    const plan = planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ runClass: "session" }),
      conversation,
      coveredToSeq: 2,
    });
    const generateTurn = vi.fn(async (): Promise<LlmTurnOutput> => ({
      type: "assistant",
      content: "{}",
    }));

    const result = await generateTaskRunSessionUpdate({
      provider: createProvider(generateTurn),
      plan,
      cache: createTaskRunSessionUpdateCache(),
    });

    expect(result.status).toBe("failed");
    expect(result.errors).toContain("task-run checkpoint plan is ineligible");
    expect(generateTurn).not.toHaveBeenCalled();
  });
});

function checkpointPlan(overrides: {
  status?: "completed" | "failed" | "blocked" | "needs_user_input";
  maxCheckpointTokens?: number;
} = {}): ReadyTaskRunCheckpointPlan {
  const status = overrides.status ?? "completed";
  const plan = planTaskRunCheckpoint({
    sessionId: "S-001",
    run: runSource({ status }),
    conversation: conversationRecords(status),
    coveredToSeq: 2,
    ...(overrides.maxCheckpointTokens ? {
      limits: { maxCheckpointTokens: overrides.maxCheckpointTokens },
    } : {}),
  });
  return readyPlan(plan);
}

function conversationRecords(status: string): GitMemoryConversationRecord[] {
  return [
    {
      seq: 1,
      role: "user",
      at: "2026-07-10T00:00:01.000Z",
      text: "Improve Ayati session context.",
    },
    {
      seq: 2,
      role: "assistant",
      ...(status === "needs_user_input" ? { kind: "feedback_question" as const } : {}),
      at: "2026-07-10T00:00:02.000Z",
      text: status === "needs_user_input"
        ? "Should I use SQLite or PostgreSQL?"
        : "The session context foundation is complete.",
    },
  ];
}

function runSource(overrides: Partial<TaskRunCheckpointRunSource> = {}): TaskRunCheckpointRunSource {
  return {
    runClass: "task",
    taskId: "W-001",
    runId: "R-001",
    status: "completed",
    summary: "Completed the session context foundation.",
    outcome: "The implementation passed verification.",
    completed: ["Implemented the foundation"],
    open: [],
    blockers: [],
    ...overrides,
  };
}

function validUpdate(plan: ReadyTaskRunCheckpointPlan): {
  sessionInterval: TaskRunCheckpointSessionInterval;
  sessionSnapshot: SessionSnapshot;
} {
  const pending = plan.pendingUserInput;
  return {
    sessionInterval: {
      summary: "The user requested better session context and the agent completed the current run.",
      userRequests: [{ seq: 1, text: "Improve Ayati session context." }],
      assistantCommitments: [],
      decisions: [],
      corrections: [],
      constraints: [],
      importantFacts: [{ seq: 2, text: "The foundation passed verification." }],
      unresolvedQuestions: pending
        ? [{ seq: pending.sourceSeq, text: pending.question }]
        : [],
      references: [],
    },
    sessionSnapshot: {
      schemaVersion: 1,
      overview: {
        summary: "The session is improving Ayati context management.",
        currentFocus: [{
          text: "Build task-run-aware session context.",
          sources: [{ kind: "conversation", seq: 1 }],
        }],
        status: pending ? "waiting_for_user" : "active",
      },
      threads: [{
        subject: "Context management",
        goal: "Preserve useful session context within bounded prompts.",
        status: pending ? "waiting" : "active",
        latestOutcome: plan.run.summary,
        next: pending ? "Wait for the user's database choice." : "Continue the context plan.",
        taskIds: [plan.run.taskId],
        runIds: [plan.run.runId],
        sources: [{ kind: "task_run", runId: plan.run.runId }],
      }],
      userRequests: [{
        text: "Improve Ayati session context.",
        status: pending ? "blocked" : "open",
        sources: [{ kind: "conversation", seq: 1 }],
      }],
      decisions: [],
      constraints: [],
      assistantCommitments: [],
      unresolvedQuestions: pending
        ? [{
            text: pending.question,
            sources: [{ kind: "conversation", seq: pending.sourceSeq }],
          }]
        : [],
      importantFacts: [{
        text: "The checkpoint foundation passed verification.",
        sources: [{ kind: "task_run", runId: plan.run.runId }],
      }],
      references: [],
      recentProgress: [{
        summary: plan.run.summary,
        taskId: plan.run.taskId,
        runId: plan.run.runId,
        status: plan.run.status,
        sources: [{ kind: "task_run", runId: plan.run.runId }],
      }],
      continuation: {
        waitingFor: pending ? "The user's exact database choice." : null,
        recommendedNext: pending ? null : "Continue implementing session context.",
        blockers: [],
      },
    },
  };
}

function readyPlan(plan: TaskRunCheckpointPlan): ReadyTaskRunCheckpointPlan {
  if (plan.status !== "ready") throw new Error(`Expected ready plan, received ${plan.status}`);
  return plan;
}

function createProvider(
  generateTurn: (input: LlmTurnInput) => Promise<LlmTurnOutput>,
): LlmProvider {
  return {
    name: "fake-provider",
    version: "test-model",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: { jsonObject: true, jsonSchema: true },
    },
    start() {},
    stop() {},
    generateTurn,
  };
}
