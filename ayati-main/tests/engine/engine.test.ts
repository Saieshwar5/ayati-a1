import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import type { StaticContext } from "../../src/context/static-context-cache.js";
import { buildSystemPrompt } from "../../src/prompt/builder.js";
import type { SystemEventPolicyConfig } from "../../src/ivec/system-event-policy.js";

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({
        type: "assistant",
        content: JSON.stringify({
          done: true,
          summary: "mock reply",
          status: "completed",
        }),
      }),
    ...overrides,
  };
}

function createSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
    beginSystemRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "sys-r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordRunLedger: vi.fn(),
    recordTaskSummary: vi.fn(),
    queueTaskSummary: vi.fn(),
    recordSystemEventOutcome: vi.fn(),
    recordAssistantNotification: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      recentSystemActivity: [],
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function createSystemEventPolicy(): SystemEventPolicyConfig {
  return {
    schemaVersion: 2,
    defaults: {
      mode: "analyze_notify",
      delivery: "notification",
      contextVisibility: "summary",
      approvalRequired: false,
    },
    rules: [
      {
        source: "pulse",
        eventClass: "trigger_fired",
        createdBy: "user",
        mode: "auto_execute_notify",
      },
      {
        source: "pulse",
        eventClass: "trigger_fired",
        createdBy: "user",
        mode: "auto_execute_notify",
      },
      {
        source: "custom-system",
        eventName: "task.requested",
        requestedAction: "send_report",
        mode: "draft_then_approve",
      },
      {
        source: "gmail-cli",
        eventName: "new_messages",
        mode: "analyze_ask",
      },
    ],
  };
}

function createStaticContext(): StaticContext {
  return {
    basePrompt: "You are Ayati.",
    soul: {
      version: 3,
      identity: {
        name: "Ayati",
        role: "General-purpose autonomous AI teammate",
        responsibility: "Help the user complete useful work.",
      },
      behavior: {
        traits: ["calm"],
        working_style: ["verify important facts"],
        communication: ["warm and direct"],
      },
      boundaries: ["invent facts"],
    },
    userProfile: {
      name: "Sai",
      nickname: null,
      occupation: "Engineer",
      location: "India",
      timezone: "Asia/Kolkata",
      languages: ["English"],
      interests: ["systems"],
      facts: ["prefers concrete answers"],
      people: [],
      projects: ["Ayati"],
      communication: {
        formality: "balanced",
        verbosity: "balanced",
        humor_receptiveness: "medium",
        emoji_usage: "rare",
      },
      emotional_patterns: {
        mood_baseline: "focused",
        stress_triggers: [],
        joy_triggers: [],
      },
      active_hours: "09:00-19:00",
      last_updated: "2026-04-18T00:00:00.000Z",
    },
    controllerPrompts: {
      understand: "",
      direct: "",
      reeval: "",
      systemEvent: "",
    },
    skillBlocks: [
      { id: "shell", content: "Use the shell tool when concrete inspection is needed." },
    ],
    toolDirectory: "shell: Run a shell command.",
  };
}

describe("IVecEngine", () => {
  it("is constructible without options", () => {
    const engine = new IVecEngine();
    expect(engine).toBeInstanceOf(IVecEngine);
  });

  it("starts and stops without provider", async () => {
    const engine = new IVecEngine();
    await engine.start();
    await engine.stop();
  });

  it("echoes chat without provider", async () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: 'Received: "hello"',
      });
    });
  });

  it("calls provider.generateTurn and returns reply", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "hello" });

      await vi.waitFor(() => {
        expect(provider.generateTurn).toHaveBeenCalled();
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "mock reply",
        });
      });
      expect(sessionMemory.recordRunLedger as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ state: "completed", status: "completed" }),
      );
      expect(sessionMemory.queueTaskSummary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records an enriched task summary only for runs that enter direct execution", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-task-"));
    try {
      let callCount = 0;
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: {
                  objective: "Find the requested config files",
                  done_when: ["the config file paths are returned"],
                  required_evidence: ["config file paths"],
                  ask_user_when: [],
                  stop_when_no_progress: ["searching no longer finds new config paths"],
                },
                approach: "inspect the workspace for config files",
              }),
            };
          }

          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Found config files",
              status: "completed",
              response_kind: "reply",
            }),
          };
        }),
      });
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "find config files" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "Found config files",
        });
      });

      expect(sessionMemory.queueTaskSummary as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          status: "completed",
          taskStatus: "not_done",
          objective: "Find the requested config files",
          summary: "Found config files",
          sessionId: "s1",
          assistantResponseKind: "reply",
          approach: "inspect the workspace for config files",
          goalDoneWhen: ["the config file paths are returned"],
          goalRequiredEvidence: ["config file paths"],
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not await task summary queueing before sending the user response", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-task-async-"));
    try {
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              done: false,
              understand: true,
              goal: {
                objective: "Collect the latest notes",
                done_when: ["notes are returned"],
                required_evidence: ["notes"],
                ask_user_when: [],
                stop_when_no_progress: [],
              },
              approach: "read the prepared notes",
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Collected the latest notes",
              status: "completed",
              response_kind: "reply",
            }),
          }),
      });
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      let releaseQueue: (() => void) | null = null;
      (sessionMemory.queueTaskSummary as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
      );

      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "collect notes" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "Collected the latest notes",
        });
      });

      expect(sessionMemory.queueTaskSummary as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      releaseQueue?.();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new IVecEngine({ onReply });

    engine.handleMessage("c1", { type: "ping" });
    engine.handleMessage("c1", { foo: "bar" });
    engine.handleMessage("c1", "raw string");

    expect(onReply).not.toHaveBeenCalled();
  });

  it("sends error reply when provider throws", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-err-"));
    try {
      const provider = createMockProvider({
        generateTurn: vi.fn().mockRejectedValue(new Error("API down")),
      });
      const onReply = vi.fn();
      const engine = new IVecEngine({ onReply, provider, dataDir });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "hello" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "error",
          content: "Failed to generate a response.",
        });
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("passes static token budget to session memory on start", async () => {
    const provider = createMockProvider();
    const sessionMemory = createSessionMemory();

    const engine = new IVecEngine({ provider, sessionMemory });
    await engine.start();

    expect(sessionMemory.setStaticTokenBudget).toHaveBeenCalledWith(expect.any(Number));
    const budget = (sessionMemory.setStaticTokenBudget as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(budget).toBe(0);

    await engine.stop();
  });

  it("builds cached understand context with the same prompt output as the canonical builder across turns", async () => {
    const staticContext = createStaticContext();
    const provider = createMockProvider();
    const sessionMemory = createSessionMemory();
    const getPromptMemoryContext = sessionMemory.getPromptMemoryContext as ReturnType<typeof vi.fn>;
    const getSessionStatus = vi.fn().mockReturnValue({
      contextPercent: 42,
      turns: 4,
      sessionAgeMinutes: 12,
      startedAt: "2026-04-18T09:00:00.000Z",
      handoffPhase: "inactive",
      pendingRotationReason: null,
    });
    sessionMemory.getSessionStatus = getSessionStatus;

    let memoryContext = {
      conversationTurns: [
        {
          role: "user" as const,
          content: "first question",
          timestamp: "2026-04-18T09:00:00.000Z",
          sessionPath: "sessions/s1.md",
        },
      ],
      previousSessionSummary: "The user is optimizing agent latency.",
      activeSessionPath: "sessions/s1.md",
      recentTaskSummaries: [
        {
          timestamp: "2026-04-18T08:30:00.000Z",
          runId: "run-1",
          runPath: "/tmp/run-1",
          runStatus: "completed" as const,
          taskStatus: "done" as const,
          objective: "Measure the current agent loop",
          summary: "Profiled understand latency",
          completedMilestones: ["Captured baseline timings"],
          openWork: [],
          blockers: [],
          keyFacts: ["understand is the first controller pass"],
          evidence: ["profiling log"],
          attachmentNames: [],
        },
      ],
      recentSystemActivity: [
        {
          timestamp: "2026-04-18T08:50:00.000Z",
          source: "engine",
          event: "cache_refresh",
          eventId: "evt-1",
          summary: "Context cache refreshed",
          userVisible: false,
        },
      ],
    };
    getPromptMemoryContext.mockImplementation(() => memoryContext);

    const engine = new IVecEngine({ provider, sessionMemory, staticContext });
    const buildSystemContext = async () => {
      const privateEngine = engine as unknown as {
        buildSystemContext(): Promise<{
          systemContext: string;
          controllerSystemContext: string;
          dynamicSystemTokens: number;
        }>;
      };
      return privateEngine.buildSystemContext();
    };

    const first = await buildSystemContext();
    const expectedFirst = buildSystemPrompt({
      basePrompt: staticContext.basePrompt,
      soul: staticContext.soul,
      userProfile: staticContext.userProfile,
      conversationTurns: memoryContext.conversationTurns,
      previousSessionSummary: memoryContext.previousSessionSummary,
      activeSessionPath: memoryContext.activeSessionPath,
      recentTaskSummaries: memoryContext.recentTaskSummaries,
      recentSystemActivity: memoryContext.recentSystemActivity,
      skillBlocks: staticContext.skillBlocks,
      toolDirectory: staticContext.toolDirectory,
      includeToolDirectory: false,
      sessionStatus: getSessionStatus(),
    }).systemPrompt;
    expect(first.systemContext).toBe(expectedFirst);
    expect(first.controllerSystemContext).toContain("# Base System Prompt");

    memoryContext = {
      ...memoryContext,
      conversationTurns: [
        ...memoryContext.conversationTurns,
        {
          role: "assistant" as const,
          content: "Here is the first answer.",
          timestamp: "2026-04-18T09:01:00.000Z",
          sessionPath: "sessions/s1.md",
        },
        {
          role: "user" as const,
          content: "follow up question",
          timestamp: "2026-04-18T09:02:00.000Z",
          sessionPath: "sessions/s1.md",
        },
      ],
    };

    const second = await buildSystemContext();
    const expectedSecond = buildSystemPrompt({
      basePrompt: staticContext.basePrompt,
      soul: staticContext.soul,
      userProfile: staticContext.userProfile,
      conversationTurns: memoryContext.conversationTurns,
      previousSessionSummary: memoryContext.previousSessionSummary,
      activeSessionPath: memoryContext.activeSessionPath,
      recentTaskSummaries: memoryContext.recentTaskSummaries,
      recentSystemActivity: memoryContext.recentSystemActivity,
      skillBlocks: staticContext.skillBlocks,
      toolDirectory: staticContext.toolDirectory,
      includeToolDirectory: false,
      sessionStatus: getSessionStatus(),
    }).systemPrompt;
    expect(second.systemContext).toBe(expectedSecond);
    expect(second.systemContext.match(/# Previous Conversation/g)).toHaveLength(1);

    const cachedConversation = (
      engine as unknown as {
        understandContextCache?: { conversationTurns: Array<{ content: string }> };
      }
    ).understandContextCache;
    expect(cachedConversation?.conversationTurns).toHaveLength(3);
    expect(cachedConversation?.conversationTurns.at(-1)?.content).toBe("follow up question");
  });

  it("processes pulse system_event through beginSystemRun", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();

      await engine.handleSystemEvent("c1", {
        type: "system_event",
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-1",
        receivedAt: "2026-03-01T10:00:05.000Z",
        summary: "Reminder due: Health",
        payload: {
          occurrenceId: "occ-1",
          reminderId: "rem-1",
          title: "Health",
          instruction: "Check system health now",
          scheduledFor: "2026-03-01T10:00:00.000Z",
          triggeredAt: "2026-03-01T10:00:05.000Z",
          timezone: "UTC",
        },
      });

      expect(sessionMemory.beginSystemRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ source: "pulse", event: "reminder_due", eventId: "evt-1" }),
      );
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
      });
      expect(sessionMemory.recordAssistantFinal as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        "sys-r1",
        "s1",
        "mock reply",
        { responseKind: "notification" },
      );
      expect(sessionMemory.recordAssistantNotification as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ message: "mock reply", source: "pulse", event: "reminder_due", eventId: "evt-1" }),
      );
      expect(sessionMemory.recordSystemEventOutcome as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          eventId: "evt-1",
          status: "completed",
          responseKind: "notification",
          note: expect.stringContaining("mode=auto_execute_notify"),
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("processes pulse scheduled task system_event through beginSystemRun", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-task-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();

      await engine.handleSystemEvent("c1", {
        type: "system_event",
        source: "pulse",
        eventName: "task_due",
        eventId: "evt-task-1",
        receivedAt: "2026-03-01T10:00:05.000Z",
        summary: "Scheduled task due: Health",
        intent: {
          kind: "task",
          requestedAction: "check_system_health",
          createdBy: "user",
        },
        payload: {
          occurrenceId: "occ-task-1",
          scheduledItemId: "task-1",
          taskId: "task-1",
          title: "Health",
          instruction: "Check system health",
          scheduledFor: "2026-03-01T10:00:00.000Z",
          triggeredAt: "2026-03-01T10:00:05.000Z",
          timezone: "UTC",
          intentKind: "task",
          requestedAction: "check_system_health",
        },
      });

      expect(sessionMemory.beginSystemRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ source: "pulse", event: "task_due", eventId: "evt-task-1" }),
      );
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
      });
      expect(sessionMemory.recordAssistantFinal as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        "sys-r1",
        "s1",
        "mock reply",
        { responseKind: "notification" },
      );
      expect(sessionMemory.recordAssistantNotification as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ message: "mock reply", source: "pulse", event: "task_due", eventId: "evt-task-1" }),
      );
      expect(sessionMemory.recordSystemEventOutcome as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          eventId: "evt-task-1",
          status: "completed",
          responseKind: "notification",
          note: expect.stringContaining("requestedAction=check_system_health"),
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("parses raw system_event intent metadata and routes approval-gated work as feedback", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-external-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = new IVecEngine({
        onReply,
        provider,
        sessionMemory,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();

      engine.handleMessage("c1", {
        type: "system_event",
        source: "custom-system",
        eventName: "task.requested",
        eventId: "evt-approval-1",
        receivedAt: "2026-03-01T10:00:05.000Z",
        summary: "Please send the status report",
        intentKind: "task",
        requestedAction: "send report",
        createdBy: "external",
        payload: {},
      });

      await vi.waitFor(() => {
        expect(sessionMemory.beginSystemRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
          "c1",
          expect.objectContaining({ source: "custom-system", event: "task.requested", eventId: "evt-approval-1" }),
        );
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "feedback",
          content: "mock reply",
        });
      });
      expect(sessionMemory.recordAssistantFinal as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        "sys-r1",
        "s1",
        "mock reply",
        { responseKind: "feedback" },
      );
      expect(sessionMemory.recordSystemEventOutcome as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          eventId: "evt-approval-1",
          status: "completed",
          responseKind: "feedback",
          note: expect.stringContaining("requestedAction=send_report"),
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rotates session before beginRun when pre-turn policy requires it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-rotate-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();

      const beginRun = vi.fn().mockReturnValue({ sessionId: "s2", runId: "r2" });
      const createSession = vi.fn().mockReturnValue({
        previousSessionId: "s1",
        sessionId: "s2",
        sessionPath: "sessions/s2.md",
      });

      const sessionMemory: SessionMemory = {
        initialize: vi.fn(),
        shutdown: vi.fn(),
        beginRun,
        createSession,
        recordToolCall: vi.fn(),
        recordToolResult: vi.fn(),
        recordAssistantFinal: vi.fn(),
        recordRunFailure: vi.fn(),
        recordAgentStep: vi.fn(),
        recordRunLedger: vi.fn(),
        recordTaskSummary: vi.fn(),
        recordAssistantNotification: vi.fn(),
        getPromptMemoryContext: vi.fn().mockReturnValue({
          conversationTurns: [
            {
              role: "user",
              content: "long task context",
              timestamp: new Date(Date.UTC(2026, 1, 20, 10, 0, 0)).toISOString(),
              sessionPath: "sessions/s1.md",
            },
          ],
          previousSessionSummary: "",
          recentSystemActivity: [],
        }),
        getSessionStatus: vi.fn().mockReturnValue({
          contextPercent: 96,
          turns: 10,
          sessionAgeMinutes: 20,
          startedAt: new Date(Date.UTC(2026, 1, 20, 8, 0, 0)).toISOString(),
          handoffPhase: "finalized",
          pendingRotationReason: "context_threshold",
        }),
        updateSessionLifecycle: vi.fn(),
        flushPersistence: vi.fn().mockResolvedValue(undefined),
        setStaticTokenBudget: vi.fn(),
      };

      const engine = new IVecEngine({ onReply, provider, sessionMemory, dataDir });
      await engine.start();

      engine.handleMessage("c1", { type: "chat", content: "continue" });

      await vi.waitFor(() => {
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(beginRun).toHaveBeenCalledTimes(1);
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "mock reply",
        });
      });

      const rotateOrder = (createSession.mock.invocationCallOrder[0] ?? 0) as number;
      const beginRunOrder = (beginRun.mock.invocationCallOrder[0] ?? 0) as number;
      expect(rotateOrder).toBeGreaterThan(0);
      expect(beginRunOrder).toBeGreaterThan(0);
      expect(rotateOrder).toBeLessThan(beginRunOrder);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
