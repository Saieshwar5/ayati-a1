import { describe, expect, it, vi } from "vitest";
import { createChatContextRuntime } from "../../src/app/chat-context-runtime.js";
import type {
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "../../src/context-engine/index.js";
import type { AgentLoopResult } from "../../src/ivec/types.js";

describe("createChatContextRuntime", () => {
  it("returns undefined when no context engine runtime is available", () => {
    expect(createChatContextRuntime({})).toBeUndefined();
  });

  it("maps ready turns and completed agent runs through the context engine runtime", async () => {
    const turn = readyContextEngineTurn();
    const contextEngineRuntime = createContextEngineRuntime(turn);
    const runtime = createChatContextRuntime({ contextEngineRuntime });

    const prepared = await runtime?.prepareUserTurn({
      clientId: "c1",
      userMessage: "Analyze invoice",
      at: "2026-06-27T10:00:00+05:30",
    });

    expect(prepared).toMatchObject({
      status: "ready",
      sessionId: "2026-06-27",
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
    });
    expect(contextEngineRuntime.prepareUserTurn).toHaveBeenCalledWith({
      userMessage: "Analyze invoice",
      at: "2026-06-27T10:00:00+05:30",
    });
    if (!prepared || prepared.status !== "ready") {
      throw new Error("Expected ready prepared turn.");
    }

    const committed = await runtime?.completePreparedRun({
      clientId: "c1",
      turn: prepared,
      result: agentLoopResult(),
      at: "2026-06-27T10:05:00+05:30",
    });

    expect(committed).toEqual({
      workId: "W-20260627-0001",
      workCommit: "work-commit",
      runRef: "refs/ayati/runs/R-20260627-0001",
    });
    expect(contextEngineRuntime.completePreparedRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      runId: "R-20260627-0001",
      assistantMessage: "I analyzed the invoice.",
      at: "2026-06-27T10:05:00+05:30",
    }));
  });

  it("records assistant messages against the prepared turn session", async () => {
    const turn = readyContextEngineTurn();
    const contextEngineRuntime = createContextEngineRuntime(turn);
    const runtime = createChatContextRuntime({ contextEngineRuntime });

    await runtime?.recordAssistantMessage({
      clientId: "c1",
      turn,
      message: "Which upload task do you mean?",
      at: "2026-06-27T10:01:00+05:30",
    });

    expect(contextEngineRuntime.recordAssistantMessage).toHaveBeenCalledWith({
      sessionId: "2026-06-27",
      text: "Which upload task do you mean?",
      at: "2026-06-27T10:01:00+05:30",
    });
  });
});

function createContextEngineRuntime(turn: ContextEnginePreparedTurn): ContextEngineRuntime {
  return {
    prepareUserTurn: vi.fn().mockResolvedValue(turn),
    completePreparedRun: vi.fn().mockResolvedValue({
      run: {
        workCommit: "work-commit",
        sessionCommit: "session-commit",
        runRef: "refs/ayati/runs/R-20260627-0001",
      },
      context: turn.context,
    }),
    recordAssistantMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function readyContextEngineTurn(): ContextEnginePreparedTurn {
  const context = {
    session: {
      sessionId: "2026-06-27",
      conversationTail: [],
      eventTail: [],
      assetCount: 0,
    },
    focus: {
      status: "active" as const,
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
    },
    task: {
      ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
      workId: "W-20260627-0001",
      title: "Analyze invoice",
      objective: "Analyze invoice",
      status: "active",
      completed: [],
      open: ["Read invoice"],
      blockers: [],
      facts: [],
      assets: [],
      recentRuns: [],
      recentCommits: [],
    },
  };
  return {
    status: "ready",
    sessionId: "2026-06-27",
    runId: "R-20260627-0001",
    workId: "W-20260627-0001",
    ref: "refs/heads/work/W-20260627-0001-analyze-invoice",
    context,
  };
}

function agentLoopResult(): AgentLoopResult {
  return {
    type: "reply",
    runClass: "interaction",
    content: "I analyzed the invoice.",
    status: "completed",
    totalIterations: 1,
    totalToolCalls: 0,
    runPath: "data/runs/r1",
  };
}
