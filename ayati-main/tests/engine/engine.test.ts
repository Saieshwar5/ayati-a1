import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IVecEngine } from "../../src/ivec/index.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { FeedbackOpenRecordInput, OpenFeedbackItem, SessionMemory } from "../../src/memory/types.js";
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
    recordSystemEventOutcome: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    recordFeedbackOpened: vi.fn().mockImplementation((_clientId: string, input: FeedbackOpenRecordInput): OpenFeedbackItem => ({
      feedbackId: "fb-1",
      status: "open",
      kind: input.kind,
      shortLabel: input.shortLabel,
      message: input.message,
      actionType: input.actionType,
      sourceRunId: input.runId,
      sourceEventId: input.sourceEventId,
      entityHints: input.entityHints ?? [],
      payloadSummary: input.payloadSummary,
      createdAt: "2026-03-25T10:00:00.000Z",
      expiresAt: "2026-03-26T10:00:00.000Z",
    })),
    recordAssistantNotification: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
      openFeedbacks: [],
      recentSystemActivity: [],
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function createSystemEventPolicy(): SystemEventPolicyConfig {
  return {
    schemaVersion: 1,
    defaults: {
      mode: "analyze_notify",
      delivery: "notification",
      contextVisibility: "summary",
      approvalRequired: false,
      feedbackTtlHours: 24,
    },
    rules: [
      {
        source: "pulse",
        eventName: "reminder_due",
        intentKind: "reminder",
        mode: "auto_execute_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
      },
      {
        source: "pulse",
        eventName: "task_due",
        intentKind: "task",
        mode: "auto_execute_notify",
        delivery: "notification",
        contextVisibility: "summary",
        approvalRequired: false,
      },
      {
        source: "custom-system",
        eventName: "task.requested",
        intentKind: "task",
        mode: "draft_then_approve",
        delivery: "feedback",
        contextVisibility: "summary",
        approvalRequired: true,
        feedbackTtlHours: 24,
      },
      {
        source: "gmail-cli",
        eventName: "new_messages",
        mode: "draft_then_approve",
        delivery: "feedback",
        contextVisibility: "summary",
        approvalRequired: true,
        feedbackTtlHours: 24,
      },
    ],
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
      expect(sessionMemory.recordTaskSummary as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ status: "completed", summary: "mock reply" }),
      );
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
          feedbackId: "fb-1",
        });
      });
      expect(sessionMemory.recordFeedbackOpened as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sourceEventId: "evt-approval-1",
          ttlHours: 24,
          actionType: "send_report",
        }),
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
        recordAssistantFeedback: vi.fn(),
        recordAssistantNotification: vi.fn(),
        recordFeedbackOpened: vi.fn().mockReturnValue(null),
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
          openFeedbacks: [],
          recentSystemActivity: [],
        }),
        getSessionStatus: vi.fn().mockReturnValue({
          contextPercent: 96,
          turns: 10,
          sessionAgeMinutes: 20,
        }),
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
