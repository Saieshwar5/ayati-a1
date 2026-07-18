import { describe, expect, it, vi } from "vitest";
import type {
  ActiveContext,
  GitContextObservabilityEvent,
  GitContextService,
  RunWorkStateInput,
} from "ayati-git-context";
import { GitContextObserver } from "ayati-git-context";
import { createGitContextRuntime } from "../../src/app/git-context-runtime.js";

describe("Git Context runtime cache", () => {
  it("warms the latest live session for the daemon startup path", async () => {
    const fixture = contextServiceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });

    await runtime.warmActiveContext();
    const warmed = await runtime.buildActiveContext("S-20260713-local");

    expect(warmed.session.meta.sessionId).toBe("S-20260713-local");
    expect(fixture.getActiveContext).toHaveBeenCalledTimes(1);
  });

  it("reuses and incrementally updates agent-ready conversation context", async () => {
    const fixture = contextServiceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });

    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Explain the context cache.",
      at: "2026-07-13T10:00:00.000Z",
    });
    const first = await runtime.buildActiveContext(turn.sessionId);
    const second = await runtime.buildActiveContext(turn.sessionId);

    expect(first).toBe(turn.context);
    expect(second).toBe(first);
    expect(fixture.getActiveContext).not.toHaveBeenCalled();
    fixture.appendConversation.mockClear();
    fixture.completeContextTurn.mockClear();

    await runtime.recordAssistantMessage({
      turn,
      message: "The cache mirrors authoritative context.",
      at: "2026-07-13T10:00:01.000Z",
    });
    const refreshed = await runtime.buildActiveContext(turn.sessionId);

    expect(refreshed).not.toBe(first);
    expect(refreshed.session.conversationTail).toHaveLength(2);
    expect(fixture.getActiveContext).not.toHaveBeenCalled();
    expect(fixture.appendConversation).not.toHaveBeenCalled();
    expect(fixture.completeContextTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: turn.sessionId,
      conversationId: turn.conversationId,
      userMessageId: turn.currentMessageId,
      assistantContent: "The cache mirrors authoritative context.",
    }));
  });

  it("rejects bypassing finalization for a run-bound assistant response", async () => {
    const fixture = contextServiceFixture();
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Read the requirements.",
      at: "2026-07-13T10:00:00.000Z",
    });

    await expect(runtime.recordAssistantMessage({
      turn,
      message: "The requirements were read.",
      runId: "R-20260713-0001",
      at: "2026-07-13T10:00:01.000Z",
    })).rejects.toThrow(
      "Run-bound assistant responses must be persisted by session or task finalization.",
    );
  });

  it("waits for pending step persistence before refreshing a dirty mirror", async () => {
    const fixture = contextServiceFixture();
    const telemetry: GitContextObservabilityEvent[] = [];
    const runtime = createGitContextRuntime({
      service: fixture.service,
      timezone: "UTC",
      agentId: "local",
      observer: new GitContextObserver("git-context-harness", (event) => telemetry.push(event)),
    });
    const turn = await runtime.prepareUserTurn({
      clientId: "local",
      userMessage: "Read the implementation.",
      at: "2026-07-13T10:00:00.000Z",
    });
    const run = await runtime.startSessionRun({
      clientId: "local",
      turn,
      at: "2026-07-13T10:00:01.000Z",
    });
    expect(run).not.toBeNull();
    await runtime.buildActiveContext(turn.sessionId);

    const refreshedByStep = await runtime.recordSessionRunStep({
      turn,
      record: {
        v: 1,
        runId: run!.runId,
        step: 1,
        status: "completed",
        completedAt: "2026-07-13T10:00:02.000Z",
        summary: "Source was read.",
        toolCalls: [{
          tool: "read_files",
          purpose: "Inspect source.",
          status: "success",
          input: { paths: ["src/index.ts"] },
          output: "source",
        }],
        verification: {
          passed: true,
          summary: "Read verified.",
          evidenceItems: [],
          newFacts: [],
          artifacts: [],
        },
        workStateAfter: workState("Source was read."),
        facts: [],
        artifacts: [],
      },
    });

    expect(refreshedByStep?.readContext?.entries).toEqual([
      expect.objectContaining({
        runId: run!.runId,
        step: 1,
        tool: "read_files",
        output: expect.objectContaining({ firstOutput: "source" }),
      }),
    ]);

    await runtime.buildActiveContext(turn.sessionId);

    expect(fixture.events.slice(-2)).toEqual(["record-step", "get-context"]);
    expect(fixture.getActiveContext).toHaveBeenCalledTimes(2);
    expect(telemetry.map((event) => event.event)).toEqual(expect.arrayContaining([
      "run_step_persistence_queued",
      "run_step_persistence_acknowledged",
      "harness_context_refresh_completed",
    ]));
    expect(telemetry.find((event) => event.event === "run_step_persistence_acknowledged")).toMatchObject({
      sessionId: turn.sessionId,
      runId: run!.runId,
      step: 1,
      data: { workStateRevision: 1, afterStep: 1 },
    });
  });

  it("finalizes only the assets explicitly accepted by task completion", async () => {
    const repositoryPath = "/workspace/aurora-coffee-site";
    const finalizeTaskRun = vi.fn(async () => ({
      runId: "R-20260713-0002",
      taskId: "T-20260713-0001",
      outcome: "done" as const,
      taskHeadBefore: "a".repeat(40),
      taskHeadAfter: "b".repeat(40),
      taskFinalizationCommit: "b".repeat(40),
      sessionCommit: "c".repeat(40),
      conversationHash: "conversation-hash",
      runFile: "runs/R-20260713-0002/run.json",
      stepsFile: "runs/R-20260713-0002/steps.jsonl",
    }));
    const service = {
      getActiveContext: vi.fn(async () => ({
        contextRevision: "revision-task",
        activeTask: {
          task: {
            taskId: "T-20260713-0001",
            repositoryPath: "/tasks/T-20260713-0001.git",
            workingPath: repositoryPath,
            branch: "main",
            head: "a".repeat(40),
          },
          workingDirectory: repositoryPath,
          title: "Aurora Coffee website",
          objective: "Build the website.",
          summary: "Website built.",
          importantPaths: [],
          recentCommits: [],
        },
        taskCandidates: [],
        warnings: [],
      })),
      finalizeTaskRun,
    } as unknown as GitContextService;
    const runtime = createGitContextRuntime({ service, timezone: "UTC", agentId: "local" });

    await runtime.completeTaskRun({
      turn: {
        status: "ready",
        sessionId: "S-20260713-local",
        repoPath: "/session",
        initialized: false,
        messageSeq: 7,
        conversationId: "C-000007",
        inputRole: "user",
        context: {} as never,
      },
      taskId: "T-20260713-0001",
      runId: "R-20260713-0002",
      result: {
        type: "reply",
        status: "completed",
        content: "The website is ready.",
        totalIterations: 4,
        totalToolCalls: 3,
        runPath: "",
        workState: {
          status: "done",
          summary: "Created and validated the website.",
          openWork: [],
          blockers: [],
          verifiedFacts: [],
          evidence: [],
          artifacts: [],
        },
        taskAssets: [{
          assetId: "nested-copy",
          role: "generated",
          kind: "file",
          name: "index.html",
          path: repositoryPath + "/aurora-coffee-site/index.html",
        }],
        verifiedCompletionAssets: [{
          assetId: "verified-index",
          role: "generated",
          kind: "file",
          name: "index.html",
          description: "Main website page.",
          path: repositoryPath + "/index.html",
        }],
      },
      at: "2026-07-13T10:05:00.000Z",
    });

    expect(finalizeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      completion: expect.objectContaining({
        accepted: true,
        assets: [{
          path: "index.html",
          kind: "file",
          description: "Main website page.",
          verified: true,
        }],
      }),
    }));
  });
});

function contextServiceFixture() {
  const sessionId = "S-20260713-local";
  const conversationId = "C-000001";
  const messages: Array<{
    messageId: string;
    conversationId: string;
    sessionSequence: number;
    segmentSequence: number;
    sequence: number;
    role: "user" | "assistant" | "system_event";
    content: string;
    at: string;
  }> = [];
  const events: string[] = [];
  let revision = 0;
  let readContextEntry: NonNullable<ActiveContext["readContext"]>["entries"][number] | undefined;
  const session = {
    sessionId,
    date: "2026-07-13",
    timezone: "UTC",
    agentId: "local",
    status: "open" as const,
    repositoryPath: "/session",
    head: "a".repeat(40),
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  const activeContext = async (): Promise<ActiveContext> => ({
    contextRevision: "revision-" + revision,
    session: {
      session,
      summary: "",
      pendingConversation: [{
        conversationId,
        sessionId,
        sequence: 1,
        filePath: "conversations/000001-session.md",
        status: "active",
      }],
      pendingConversationContext: [{
        conversation: {
          conversationId,
          sessionId,
          sequence: 1,
          filePath: "conversations/000001-session.md",
          status: "active",
        },
        messages: [...messages],
        contentHash: "hash-" + revision,
      }],
      pendingDigest: "digest-" + revision,
      recentCommits: [],
    },
    ...(readContextEntry ? {
      readContext: {
        revision: "read-revision-" + revision,
        entries: [readContextEntry],
      },
    } : {}),
    taskCandidates: [],
    warnings: [],
  });
  const getActiveContext = vi.fn(async (): Promise<ActiveContext> => {
    events.push("get-context");
    return await activeContext();
  });
  const appendMessage = async (input: {
    role: "user" | "assistant" | "system_event";
    content: string;
    at: string;
  }) => {
    const sessionSequence = messages.length + 1;
    const messageId = sessionId + "-M-" + String(sessionSequence).padStart(6, "0");
    messages.push({
      messageId,
      conversationId,
      sessionSequence,
      segmentSequence: messages.length + 1,
      sequence: messages.length + 1,
      role: input.role,
      content: input.content,
      at: input.at,
    });
    revision += 1;
    return {
      conversation: {
        conversationId,
        sessionId,
        sequence: 1,
        filePath: "conversations/000001-session.md",
        status: "active" as const,
      },
      message: messages.at(-1)!,
      contextRevision: "revision-" + revision,
      pendingDigest: "digest-" + revision,
    };
  };
  const appendConversation = vi.fn(appendMessage);
  const completeContextTurn = vi.fn(async (input: {
    assistantContent: string;
    at: string;
  }) => await appendMessage({
    role: "assistant",
    content: input.assistantContent,
    at: input.at,
  }));
  const service = {
    prepareContextTurn: vi.fn(async (input: {
      role: "user" | "system_event";
      content: string;
      at: string;
    }) => {
      const appended = await appendConversation(input);
      return {
        session,
        sessionCreated: false,
        conversation: appended.conversation,
        message: appended.message,
        context: await activeContext(),
      };
    }),
    ensureActiveSession: vi.fn(async () => ({
      session,
      created: false,
    })),
    appendConversation,
    completeContextTurn,
    getActiveContext,
    startRun: vi.fn(async () => {
      revision += 1;
      return {
        run: {
          runId: "R-20260713-0001",
          sessionId,
          conversationId,
          runClass: "session" as const,
        },
      };
    }),
    recordRunStep: vi.fn(async (input: {
      step: number;
      tool: string;
      purpose: string;
      input?: unknown;
      output?: unknown;
      verification?: unknown;
      workState: RunWorkStateInput;
      at: string;
    }) => {
      await Promise.resolve();
      events.push("record-step");
      revision += 1;
      readContextEntry = {
        key: "read_files:src/index.ts",
        runId: "R-20260713-0001",
        step: input.step,
        runClass: "session",
        tool: input.tool,
        purpose: input.purpose,
        resources: ["src/index.ts"],
        input: input.input,
        output: input.output,
        verification: input.verification ?? { passed: true },
        createdAt: input.at,
      };
      return {
        toolCall: {
          step: input.step,
          tool: input.tool,
          toolSchemaVersion: 1,
          toolEffect: "read_only" as const,
          purpose: input.purpose,
          status: "completed" as const,
        },
        workState: {
          ...input.workState,
          runId: "R-20260713-0001",
          revision: 1,
          afterStep: input.step,
          updatedAt: input.at,
        },
      };
    }),
  } as unknown as GitContextService;
  getActiveContext.mockClear();
  events.length = 0;
  return { service, getActiveContext, appendConversation, completeContextTurn, events };
}

function workState(summary: string): RunWorkStateInput {
  return {
    status: "not_done",
    summary,
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
