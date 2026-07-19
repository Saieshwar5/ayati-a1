import { describe, expect, it, vi } from "vitest";
import type { FinalizeRunResponse } from "ayati-git-context";
import {
  finalizeAgentRun,
  isTaskBoundRun,
} from "../../src/app/run-finalization-coordinator.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "../../src/app/git-context-runtime.js";
import type { AgentLoopResult } from "../../src/ivec/types.js";

describe("run finalization coordinator", () => {
  it("finalizes a direct zero-step run through the single durable path", async () => {
    const finalizeRun = vi.fn(async () => finalizationResponse("R-direct"));
    const result = directResult("R-direct");

    const response = await finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-direct", false),
      result,
      at: "2026-07-19T10:01:00.000Z",
    });

    expect(response.run.runId).toBe("R-direct");
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({ run: expect.objectContaining({ runId: "R-direct" }) }),
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "A direct answer.",
      validation: "not_applicable",
    }));
    expect(finalizeRun.mock.calls[0]?.[0]).not.toHaveProperty("taskCompletion");
  });

  it("loads task ownership from run context and sends accepted completion evidence", async () => {
    const finalizeRun = vi.fn(async () => finalizationResponse("R-task", true));
    const result = taskResult("R-task");

    await finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-task", true),
      result,
      at: "2026-07-19T10:01:00.000Z",
    });

    expect(isTaskBoundRun(preparedTurn("R-task", true), result)).toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "done",
      validation: "passed",
      taskCompletion: expect.objectContaining({
        accepted: true,
        assets: [{
          path: "site/index.html",
          kind: "file",
          description: "Generated homepage",
          verified: true,
        }],
      }),
    }));
  });

  it("does not acknowledge a run when durable finalization fails", async () => {
    const finalizeRun = vi.fn(async () => {
      throw new Error("final commit failed");
    });

    await expect(finalizeAgentRun({
      runtime: runtime(finalizeRun),
      turn: preparedTurn("R-failed", false),
      result: directResult("R-failed"),
      at: "2026-07-19T10:01:00.000Z",
    })).rejects.toThrow("final commit failed");
    expect(finalizeRun).toHaveBeenCalledTimes(1);
  });
});

function runtime(finalizeRun: ReturnType<typeof vi.fn>): GitContextRuntime {
  return { finalizeRun } as unknown as GitContextRuntime;
}

function preparedTurn(runId: string, bound: boolean): GitContextPreparedTurn {
  return {
    status: "ready",
    sessionId: "S-1",
    repoPath: "/session",
    initialized: false,
    messageSeq: 1,
    currentMessageId: "M-1",
    currentMessageSessionSequence: 1,
    conversationId: "C-1",
    inputRole: "user",
    run: {
      runId,
      sessionId: "S-1",
      conversationId: "C-1",
      triggerSeq: 1,
    },
    context: {
      session: {
        meta: { sessionId: "S-1", assetCount: 0 },
        conversationTail: [],
        activityTail: [],
      },
      ...(bound ? {
        pendingTurn: {
          fromSeq: 1,
          toSeq: 1,
          text: "Build the page",
          at: "2026-07-19T10:00:00.000Z",
          routingStatus: "bound" as const,
          workId: "T-1",
          branch: "task/T-1",
          runId,
        },
      } : {}),
      focus: bound
        ? { status: "active", ref: "refs/heads/task/T-1", workId: "T-1" }
        : { status: "none" },
    },
  };
}

function directResult(runId: string): AgentLoopResult {
  return {
    type: "reply",
    runId,
    outcome: "done",
    stopReason: "completed",
    content: "A direct answer.",
    status: "completed",
    totalIterations: 1,
    totalToolCalls: 0,
    runPath: "",
    workState: {
      status: "done",
      summary: "Answered directly.",
      openWork: [],
      blockers: [],
      verifiedFacts: [],
      evidence: [],
    },
  };
}

function taskResult(runId: string): AgentLoopResult {
  const result = directResult(runId);
  return {
    ...result,
    content: "Created the page.",
    workState: {
      ...result.workState!,
      summary: "Created the page.",
    },
    verifiedCompletionAssets: [{
      assetId: "A-1",
      role: "output",
      kind: "file",
      name: "index.html",
      path: "site/index.html",
      description: "Generated homepage",
    }],
    harnessContext: {
      personalMemorySnapshot: "",
      contextEngine: preparedTurn(runId, true).context,
    },
  };
}

function finalizationResponse(runId: string, bound = false): FinalizeRunResponse {
  return {
    run: {
      runId,
      sessionId: "S-1",
      conversationId: "C-1",
      triggerSeq: 1,
      status: "done",
      outcome: "done",
      stopReason: "completed",
      stepCount: 0,
      startedAt: "2026-07-19T10:00:00.000Z",
      completedAt: "2026-07-19T10:01:00.000Z",
      workState: {
        version: 1,
        revision: 1,
        status: "done",
        summary: "done",
        openWork: [],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
        updatedAt: "2026-07-19T10:01:00.000Z",
      },
      ...(bound ? {
        taskBinding: {
          taskId: "T-1",
          taskRequestId: "REQ-1",
          boundAt: "2026-07-19T10:00:10.000Z",
        },
      } : {}),
    },
    conversation: {
      conversationId: "C-1",
      sessionId: "S-1",
      sequence: 1,
      filePath: "conversations/1.md",
      status: "closed",
    },
    persistence: {
      database: "saved",
      materialization: "not_requested",
      git: "not_committed",
    },
    materialization: { status: "not_requested" },
    commit: { status: "not_required" },
  };
}
