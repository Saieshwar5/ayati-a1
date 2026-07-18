import { describe, expect, it, vi } from "vitest";
import {
  createChatTurnRuntime,
} from "../../src/app/chat-turn-runtime.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "../../src/app/git-context-runtime.js";
import type { AgentLoopResult } from "../../src/ivec/types.js";
import type { MemoryRunHandle } from "../../src/memory/types.js";

describe("chat final-response persistence", () => {
  it("lets session-run finalization persist the assistant response exactly once", async () => {
    const contextRuntime = contextRuntimeFixture();
    const runtime = createChatTurnRuntime({
      chatContextRuntime: contextRuntime.runtime,
      now: () => new Date("2026-07-14T10:00:00.000Z"),
    });

    await completeContextRun(runtime, completedSessionResult(), sessionRunHandle());

    expect(contextRuntime.recordAssistantMessage).not.toHaveBeenCalled();
    expect(contextRuntime.finalizeSessionRun).toHaveBeenCalledTimes(1);
    expect(contextRuntime.finalizeSessionRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "R-20260714-0001",
      assistantResponse: "The requirements specify an Aurora Coffee website.",
    }));
  });

  it("persists a direct response normally when no run exists", async () => {
    const contextRuntime = contextRuntimeFixture();
    const runtime = createChatTurnRuntime({
      chatContextRuntime: contextRuntime.runtime,
      now: () => new Date("2026-07-14T10:00:00.000Z"),
    });

    await completeContextRun(runtime, completedDirectResult());

    expect(contextRuntime.finalizeSessionRun).not.toHaveBeenCalled();
    expect(contextRuntime.recordAssistantMessage).toHaveBeenCalledTimes(1);
    expect(contextRuntime.recordAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: "HTML defines the structure of a webpage.",
    }));
  });

  it("does not complete a direct response when durable persistence fails", async () => {
    const contextRuntime = contextRuntimeFixture();
    contextRuntime.recordAssistantMessage.mockRejectedValueOnce(
      new Error("assistant persistence failed"),
    );
    const runtime = createChatTurnRuntime({
      chatContextRuntime: contextRuntime.runtime,
      now: () => new Date("2026-07-14T10:00:00.000Z"),
    });

    await expect(completeContextRun(runtime, completedDirectResult())).rejects.toThrow(
      "assistant persistence failed",
    );
    expect(contextRuntime.finalizeSessionRun).not.toHaveBeenCalled();
  });
});

async function completeContextRun(
  runtime: ReturnType<typeof createChatTurnRuntime>,
  result: AgentLoopResult,
  runHandle?: MemoryRunHandle,
): Promise<void> {
  await (runtime as unknown as {
    completeChatContextRun(
      clientId: string,
      prepared: GitContextPreparedTurn,
      routed: null,
      result: AgentLoopResult,
      sessionRunHandle?: MemoryRunHandle,
    ): Promise<unknown>;
  }).completeChatContextRun("client-1", preparedTurn(), null, result, runHandle);
}

function contextRuntimeFixture(): {
  runtime: GitContextRuntime;
  recordAssistantMessage: ReturnType<typeof vi.fn>;
  finalizeSessionRun: ReturnType<typeof vi.fn>;
} {
  const recordAssistantMessage = vi.fn(async () => ({
    conversationId: "C-000001",
    sessionId: "S-20260714-local",
    sequence: 1,
    filePath: "conversations/000001-session.md",
    status: "active" as const,
  }));
  const finalizeSessionRun = vi.fn(async () => ({ runId: "R-20260714-0001" }));
  return {
    recordAssistantMessage,
    finalizeSessionRun,
    runtime: {
      recordAssistantMessage,
      finalizeSessionRun,
    } as unknown as GitContextRuntime,
  };
}

function preparedTurn(): GitContextPreparedTurn {
  return {
    status: "ready",
    sessionId: "S-20260714-local",
    repoPath: "/session",
    initialized: false,
    messageSeq: 1,
    currentMessageId: "S-20260714-local-M-000001",
    currentMessageSessionSequence: 1,
    conversationId: "C-000001",
    inputRole: "user",
    context: {
      session: {
        meta: {
          sessionId: "S-20260714-local",
          date: "2026-07-14",
          timezone: "UTC",
          repoKind: "daily_session",
          assetCount: 0,
        },
        conversationTail: [],
        activityTail: [],
      },
      focus: { status: "none" },
    },
  };
}

function sessionRunHandle(): MemoryRunHandle {
  return {
    sessionId: "S-20260714-local",
    runId: "R-20260714-0001",
    triggerSeq: 1,
  };
}

function completedSessionResult(): AgentLoopResult {
  return {
    type: "reply",
    runClass: "session",
    content: "The requirements specify an Aurora Coffee website.",
    status: "completed",
    totalIterations: 2,
    totalToolCalls: 1,
    runPath: "",
    workState: {
      status: "done",
      summary: "The requirements file was read and explained.",
      openWork: [],
      blockers: [],
      verifiedFacts: ["The website name is Aurora Coffee."],
      evidence: ["read_files completed successfully."],
      artifacts: [],
    },
  };
}

function completedDirectResult(): AgentLoopResult {
  return {
    type: "reply",
    runClass: "session",
    content: "HTML defines the structure of a webpage.",
    status: "completed",
    totalIterations: 1,
    totalToolCalls: 0,
    runPath: "",
  };
}
