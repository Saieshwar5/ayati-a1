import { describe, expect, it } from "vitest";
import {
  generateDeterministicTaskRunCheckpoint,
  planTaskRunCheckpoint,
} from "../../../src/context-engine/git-memory/index.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunStatus,
  ReadyTaskRunCheckpointPlan,
  TaskRunCheckpointPlan,
  TaskRunCheckpointRunSource,
} from "../../../src/context-engine/git-memory/index.js";

describe("deterministic task-run checkpoint generation", () => {
  it("rejects a plan that is not ready", () => {
    const plan = planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ runClass: "session" }),
      conversation: conversation(2),
      coveredToSeq: 2,
    });

    expect(generateDeterministicTaskRunCheckpoint({ plan })).toEqual({
      status: "failed",
      strategy: "deterministic",
      errors: ["task-run checkpoint plan is ineligible"],
      omitted: [],
    });
  });

  it("builds a validated checkpoint from conversation and structured run facts", () => {
    const records = conversation(4);
    records[2] = {
      ...records[2]!,
      text: null,
      contentRef: "document://requirements-1",
    };
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 4,
    }));

    const result = generateDeterministicTaskRunCheckpoint({
      plan,
      context: {
        decisions: ["Use PostgreSQL", "Use PostgreSQL"],
        importantFacts: ["The migration passed verification"],
        references: ["src/database.ts", "src/database.ts"],
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.checkpoint).toMatchObject({
      checkpointId: plan.checkpointId,
      coverage: plan.coverage,
      run: plan.run,
      sessionInterval: {
        summary: "Run completed: Completed the requested task run. Outcome: The requested change is verified.",
        userRequests: [
          { seq: 1, text: "User request 1" },
          { seq: 3, text: "[content: document://requirements-1]" },
        ],
        assistantCommitments: [],
        decisions: [{ seq: 4, text: "Use PostgreSQL" }],
        corrections: [],
        constraints: [],
        importantFacts: [{ seq: 4, text: "The migration passed verification" }],
        unresolvedQuestions: [],
        references: [
          { seq: 3, text: "document://requirements-1" },
          { seq: 4, text: "src/database.ts" },
        ],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(plan.limits.maxCheckpointTokens);
  });

  it.each<GitMemoryRunStatus>(["completed", "failed", "blocked", "needs_user_input"])(
    "renders a deterministic interval summary for %s",
    (status) => {
      const records = conversation(2);
      if (status === "needs_user_input") {
        records[1] = {
          ...records[1]!,
          kind: "feedback_question",
          text: "Choose SQLite or PostgreSQL?",
        };
      }
      const plan = readyPlan(planTaskRunCheckpoint({
        sessionId: "S-001",
        run: runSource({ status }),
        conversation: records,
        coveredToSeq: 2,
      }));
      const result = generateDeterministicTaskRunCheckpoint({ plan });

      expect(result.status).toBe("success");
      if (result.status !== "success") return;
      expect(result.checkpoint.sessionInterval.summary).toContain(statusLabel(status));
      if (status === "needs_user_input") {
        expect(result.checkpoint.pendingUserInput).toEqual({
          question: "Choose SQLite or PostgreSQL?",
          sourceSeq: 2,
        });
        expect(result.checkpoint.sessionInterval.unresolvedQuestions).toEqual([{
          seq: 2,
          text: "Choose SQLite or PostgreSQL?",
        }]);
      }
    },
  );

  it("does not invent semantics without structured evidence", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(4),
      coveredToSeq: 4,
    }));
    const result = generateDeterministicTaskRunCheckpoint({ plan });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.checkpoint.sessionInterval).toMatchObject({
      assistantCommitments: [],
      decisions: [],
      corrections: [],
      constraints: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
    });
  });

  it("is deterministic and does not mutate the plan or structured input", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(6),
      coveredToSeq: 6,
    }));
    const context = {
      decisions: ["Keep the checkpoint deterministic"],
      importantFacts: ["The source hash was verified"],
      references: ["agent-notes/context.md"],
    };
    const originalPlan = structuredClone(plan);
    const originalContext = structuredClone(context);

    const first = generateDeterministicTaskRunCheckpoint({ plan, context });
    const second = generateDeterministicTaskRunCheckpoint({ plan, context });

    expect(first).toEqual(second);
    expect(plan).toEqual(originalPlan);
    expect(context).toEqual(originalContext);
  });

  it("drops older user request statements before protected recent context", () => {
    const records = conversation(10).map((record) => (
      record.role === "user" && record.seq < 9
        ? { ...record, text: `Older request ${record.seq}: ${"x".repeat(1_000)}` }
        : record
    ));
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 10,
      limits: {
        recentExchangeLimit: 1,
        maxCheckpointTokens: 1_000,
      },
    }));

    const result = generateDeterministicTaskRunCheckpoint({ plan });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.omitted).toEqual([{
      field: "userRequests",
      count: 2,
      reason: "checkpoint_token_budget",
    }]);
    expect(result.checkpoint.recentExactConversation.map((record) => record.seq)).toEqual([9, 10]);
    expect(result.checkpoint.sessionInterval.userRequests.map((request) => request.seq)).toEqual([5, 7, 9]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(1_000);
  });

  it("removes references and facts before higher-priority decisions", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(2),
      coveredToSeq: 2,
      limits: { maxCheckpointTokens: 500 },
    }));
    const long = (label: string) => `${label}: ${"x".repeat(900)}`;

    const result = generateDeterministicTaskRunCheckpoint({
      plan,
      context: {
        decisions: [long("decision")],
        importantFacts: [long("fact")],
        references: [long("reference")],
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.omitted).toEqual([
      { field: "references", count: 1, reason: "checkpoint_token_budget" },
      { field: "importantFacts", count: 1, reason: "checkpoint_token_budget" },
    ]);
    expect(result.checkpoint.sessionInterval.decisions).toHaveLength(1);
    expect(result.estimatedTokens).toBeLessThanOrEqual(500);
  });

  it("fails instead of removing protected context when the protected base exceeds budget", () => {
    const records = conversation(2);
    records[1] = {
      ...records[1]!,
      kind: "feedback_question",
      text: "Which option should I use?",
    };
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ status: "needs_user_input" }),
      conversation: records,
      coveredToSeq: 2,
      limits: { maxCheckpointTokens: 50 },
    }));

    const result = generateDeterministicTaskRunCheckpoint({ plan });

    expect(result).toMatchObject({
      status: "failed",
      strategy: "deterministic",
      errors: [expect.stringContaining("checkpoint uses")],
      estimatedTokens: expect.any(Number),
    });
  });

  it("removes a duplicated outcome suffix before failing the protected run context", () => {
    const longOutcome = `Verified outcome: ${"x".repeat(1_000)}`;
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ outcome: longOutcome }),
      conversation: conversation(2),
      coveredToSeq: 2,
      limits: { maxCheckpointTokens: 650 },
    }));

    const result = generateDeterministicTaskRunCheckpoint({ plan });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.omitted).toContainEqual({
      field: "sessionIntervalSummary",
      count: 1,
      reason: "checkpoint_token_budget",
    });
    expect(result.checkpoint.run.outcome).toBe(longOutcome);
    expect(result.checkpoint.sessionInterval.summary).not.toContain(longOutcome);
    expect(result.estimatedTokens).toBeLessThanOrEqual(650);
  });

  it("fails validation when trusted source records change after planning", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(2),
      coveredToSeq: 2,
    }));
    plan.sourceRecords[0] = { ...plan.sourceRecords[0]!, text: "mutated after planning" };

    expect(generateDeterministicTaskRunCheckpoint({ plan })).toMatchObject({
      status: "failed",
      errors: expect.arrayContaining([
        "plan source records no longer match the source hash",
      ]),
    });
  });
});

function runSource(overrides: Partial<TaskRunCheckpointRunSource> = {}): TaskRunCheckpointRunSource {
  return {
    runClass: "task",
    taskId: "W-001",
    runId: "R-001",
    status: "completed",
    summary: "Completed the requested task run.",
    outcome: "The requested change is verified.",
    completed: ["Implemented the change"],
    open: [],
    blockers: [],
    ...overrides,
  };
}

function conversation(count: number): GitMemoryConversationRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    return {
      seq,
      role: seq % 2 === 0 ? "assistant" as const : "user" as const,
      at: `2026-07-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
      text: seq % 2 === 0 ? `Assistant response ${seq}` : `User request ${seq}`,
    };
  });
}

function readyPlan(plan: TaskRunCheckpointPlan): ReadyTaskRunCheckpointPlan {
  if (plan.status !== "ready") {
    throw new Error(`Expected ready checkpoint plan, received ${plan.status}`);
  }
  return plan;
}

function statusLabel(status: GitMemoryRunStatus): string {
  switch (status) {
    case "completed":
      return "Run completed";
    case "failed":
      return "Run failed";
    case "blocked":
      return "Run blocked";
    case "needs_user_input":
      return "Run needs user input";
  }
}
