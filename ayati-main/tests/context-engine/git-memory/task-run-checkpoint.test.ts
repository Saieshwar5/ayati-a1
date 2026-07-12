import { describe, expect, it } from "vitest";
import {
  hashTaskRunCheckpointSource,
  planTaskRunCheckpoint,
  validateTaskRunCheckpointAgainstPlan,
} from "../../../src/context-engine/git-memory/index.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryRunStatus,
  ReadyTaskRunCheckpointPlan,
  TaskRunCheckpoint,
  TaskRunCheckpointPlan,
  TaskRunCheckpointRunSource,
} from "../../../src/context-engine/git-memory/index.js";

describe("task-run checkpoint planning", () => {
  it("rejects session runs as checkpoint boundaries", () => {
    const plan = planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ runClass: "session" }),
      conversation: conversation(4),
      coveredToSeq: 4,
    });

    expect(plan).toEqual({
      schemaVersion: 1,
      status: "ineligible",
      reason: "session_run",
    });
  });

  it("rejects unfinished task runs as checkpoint boundaries", () => {
    const plan = planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ status: "running" }),
      conversation: conversation(4),
      coveredToSeq: 4,
    });

    expect(plan).toEqual({
      schemaVersion: 1,
      status: "ineligible",
      reason: "task_run_not_finalized",
    });
  });

  it.each<GitMemoryRunStatus>(["completed", "incomplete", "failed", "blocked", "needs_user_input"])(
    "accepts the finalized %s task-run status",
    (status) => {
      const records = conversation(4);
      if (status === "needs_user_input") {
        records[3] = { ...records[3]!, kind: "feedback_question" };
      }
      const plan = planTaskRunCheckpoint({
        sessionId: "S-001",
        run: runSource({ status }),
        conversation: records,
        coveredToSeq: 4,
      });

      expect(plan.status).toBe("ready");
      if (plan.status === "ready") expect(plan.run.status).toBe(status);
    },
  );

  it("covers every conversation record after the previous task-run checkpoint", () => {
    const records = conversation(10).map((record) => (
      record.seq === 7 ? { ...record, runId: "session-run-2" } : record
    ));
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      previousCoveredUntilSeq: 4,
      coveredToSeq: 10,
    }));

    expect(plan.coverage).toMatchObject({
      fromSeq: 5,
      toSeq: 10,
      sourceEventCount: 6,
    });
    expect(plan.sourceRecords.map((record) => record.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(plan.sourceRecords.find((record) => record.seq === 7)?.runId).toBe("session-run-2");
  });

  it("keeps the latest three user-led exchanges exact", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(10),
      coveredToSeq: 10,
    }));

    expect(plan.recentExactConversation.map((record) => record.seq)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("preserves the pending assistant question exactly", () => {
    const records = conversation(4);
    records[3] = {
      ...records[3]!,
      kind: "feedback_question",
      text: "  Should I use SQLite or PostgreSQL?  ",
    };
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ status: "needs_user_input" }),
      conversation: records,
      coveredToSeq: 4,
    }));

    expect(plan.pendingUserInput).toEqual({
      question: "  Should I use SQLite or PostgreSQL?  ",
      sourceSeq: 4,
    });
    expect(plan.recentExactConversation.at(-1)?.text).toBe("  Should I use SQLite or PostgreSQL?  ");
  });

  it("rejects needs_user_input without an explicit feedback question", () => {
    expect(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ status: "needs_user_input" }),
      conversation: conversation(4),
      coveredToSeq: 4,
    })).toMatchObject({
      status: "invalid",
      errors: expect.arrayContaining([
        "needs_user_input task run must end with an exact assistant question",
      ]),
    });
  });

  it("rejects missing and duplicated conversation sequences", () => {
    const missing = conversation(6).filter((record) => record.seq !== 3);
    const duplicate = [...conversation(6), { ...conversation(6)[2]! }];

    expect(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: missing,
      coveredToSeq: 6,
    })).toMatchObject({
      status: "invalid",
      errors: expect.arrayContaining(["conversation interval is missing sequence 3"]),
    });
    expect(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: duplicate,
      coveredToSeq: 6,
    })).toMatchObject({
      status: "invalid",
      errors: expect.arrayContaining(["conversation sequence 3 is duplicated"]),
    });
  });

  it("rejects an interval without a final assistant message", () => {
    const records = conversation(4);
    records[3] = { ...records[3]!, role: "user" };

    expect(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 4,
    })).toMatchObject({
      status: "invalid",
      errors: expect.arrayContaining([
        "checkpoint conversation interval must end with the final assistant message",
      ]),
    });
  });

  it("enforces the exact-conversation token ceiling without truncating source", () => {
    const records = conversation(2);
    records[0] = { ...records[0]!, text: "x".repeat(2_000) };

    expect(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 2,
      limits: { maxExactConversationTokens: 20 },
    })).toMatchObject({
      status: "invalid",
      errors: [expect.stringContaining("recent exact conversation uses")],
    });
    expect(records[0]?.text).toHaveLength(2_000);
  });

  it("produces stable source hashes and checkpoint identities without mutating input", () => {
    const records = conversation(6).reverse();
    const original = structuredClone(records);
    const first = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 6,
    }));
    const second = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: records,
      coveredToSeq: 6,
    }));
    const changed = conversation(6);
    changed[0] = { ...changed[0]!, text: "changed request" };

    expect(first.checkpointId).toBe(second.checkpointId);
    expect(first.coverage.sourceHash).toBe(second.coverage.sourceHash);
    expect(hashTaskRunCheckpointSource(changed)).not.toBe(first.coverage.sourceHash);
    expect(records).toEqual(original);
    expect(first.sourceRecords).not.toBe(records);
  });

  it("validates generated content against coverage, exact context, and token limits", () => {
    const plan = readyPlan(planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource(),
      conversation: conversation(4),
      coveredToSeq: 4,
    }));
    const checkpoint = checkpointFor(plan);

    expect(validateTaskRunCheckpointAgainstPlan(checkpoint, plan)).toEqual([]);
    expect(validateTaskRunCheckpointAgainstPlan({
      ...checkpoint,
      coverage: { ...checkpoint.coverage, toSeq: 99 },
      sessionInterval: {
        ...checkpoint.sessionInterval,
        constraints: [{ seq: 99, text: "invented constraint" }],
      },
    }, plan)).toEqual(expect.arrayContaining([
      "coverage does not match the plan",
      "checkpoint statement seq 99 is not in the covered conversation",
    ]));
  });

  it("refuses to validate a checkpoint against an ineligible plan", () => {
    const plan = planTaskRunCheckpoint({
      sessionId: "S-001",
      run: runSource({ runClass: "session" }),
      conversation: conversation(2),
      coveredToSeq: 2,
    });

    expect(validateTaskRunCheckpointAgainstPlan({} as TaskRunCheckpoint, plan)).toEqual([
      "task-run checkpoint plan is ineligible",
    ]);
  });
});

function runSource(overrides: Partial<TaskRunCheckpointRunSource> = {}): TaskRunCheckpointRunSource {
  return {
    runClass: "task" as const,
    taskId: "W-001",
    runId: "R-001",
    status: "completed" as const,
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

function checkpointFor(plan: ReadyTaskRunCheckpointPlan): TaskRunCheckpoint {
  const firstUser = plan.sourceRecords.find((record) => record.role === "user")!;
  return {
    schemaVersion: 1,
    checkpointId: plan.checkpointId,
    sessionId: plan.sessionId,
    coverage: plan.coverage,
    run: plan.run,
    sessionInterval: {
      summary: "The user requested work and the agent completed it.",
      userRequests: [{ seq: firstUser.seq, text: firstUser.text ?? "User requested work." }],
      assistantCommitments: [],
      decisions: [],
      corrections: [],
      constraints: [],
      importantFacts: [],
      unresolvedQuestions: [],
      references: [],
    },
    recentExactConversation: plan.recentExactConversation,
    ...(plan.pendingUserInput ? { pendingUserInput: plan.pendingUserInput } : {}),
  };
}
