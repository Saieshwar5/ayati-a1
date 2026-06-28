import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IVecEngine } from "../../src/ivec/index.js";
import {
  createChatTurnRuntime,
  type CreateChatTurnRuntimeOptions,
} from "../../src/app/chat-turn-runtime.js";
import {
  createSystemEventRuntime,
  type CreateSystemEventRuntimeOptions,
} from "../../src/app/system-event-runtime.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import type { StaticContext } from "../../src/context/static-context-cache.js";
import type { SystemEventPolicyConfig } from "../../src/ivec/system-event-policy.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type {
  ChatContextPreparedTurn,
  ChatContextRuntime,
} from "../../src/ivec/chat-context-runtime.js";

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
          kind: "reply",
          message: "mock reply",
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
    recordUserMessage: vi.fn().mockReturnValue({ sessionId: "s1", seq: 1 }),
    recordSystemEvent: vi.fn().mockReturnValue({ sessionId: "s1", seq: 1 }),
    createWorkRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1", triggerSeq: 1 }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordAssistantMessage: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordSystemEventOutcome: vi.fn(),
    recordAssistantNotification: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
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
        role: "General-purpose AI teammate",
        responsibility: "Help the user complete useful work.",
      },
      behavior: {
        traits: ["calm"],
        working_style: ["verify important facts"],
        communication: ["warm and direct"],
      },
      boundaries: ["invent facts"],
    },
    skillBlocks: [
      { id: "shell", content: "Use the shell tool when concrete inspection is needed." },
    ],
    toolDirectory: "shell: Run a shell command.",
  };
}

function findReplyContent(onReply: ReturnType<typeof vi.fn>, type = "reply"): string {
  const call = onReply.mock.calls.find(([, message]) => {
    return typeof message === "object"
      && message !== null
      && (message as { type?: unknown }).type === type;
  });
  const message = call?.[1] as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : "";
}

function createChatContextRuntime(turn: ChatContextPreparedTurn): ChatContextRuntime {
  return {
    prepareUserTurn: vi.fn().mockResolvedValue(turn),
    completePreparedRun: vi.fn().mockResolvedValue({
      workId: turn.status === "ready" ? turn.workId : "W-20260627-0001",
      workCommit: "work-commit",
      runRef: "refs/ayati/runs/R-20260627-0001",
    }),
    recordAssistantMessage: vi.fn().mockResolvedValue(undefined),
  };
}

type TestEngineOptions =
  & Omit<Partial<CreateChatTurnRuntimeOptions & CreateSystemEventRuntimeOptions>, "sessionMemory" | "chatContextRuntime">
  & {
    sessionMemory?: SessionMemory;
    chatContextRuntime?: ChatContextRuntime;
  };

function createEngine(options: TestEngineOptions = {}): IVecEngine {
  const sessionMemory = options.sessionMemory ?? createSessionMemory();
  const chatContextRuntime = options.chatContextRuntime ?? createChatContextRuntime(readyChatContextTurn());
  const chatTurnRuntime = createChatTurnRuntime({
    onReply: options.onReply,
    provider: options.provider,
    staticContext: options.staticContext,
    sessionMemory,
    toolExecutor: options.toolExecutor,
    skillActivationManager: options.skillActivationManager,
    toolWorkingSetManager: options.toolWorkingSetManager,
    loopConfig: options.loopConfig,
    rotationPolicyConfig: options.rotationPolicyConfig,
    now: options.now,
    dataDir: options.dataDir,
    documentStore: options.documentStore,
    preparedAttachmentRegistry: options.preparedAttachmentRegistry,
    fileLibrary: options.fileLibrary,
    directoryLibrary: options.directoryLibrary,
    feedbackLedger: options.feedbackLedger,
    chatContextRuntime,
  });
  const systemEventRuntime = createSystemEventRuntime({
    onReply: options.onReply,
    provider: options.provider,
    staticContext: options.staticContext,
    sessionMemory,
    toolExecutor: options.toolExecutor,
    skillActivationManager: options.skillActivationManager,
    toolWorkingSetManager: options.toolWorkingSetManager,
    loopConfig: options.loopConfig,
    rotationPolicyConfig: options.rotationPolicyConfig,
    now: options.now,
    dataDir: options.dataDir,
    documentStore: options.documentStore,
    preparedAttachmentRegistry: options.preparedAttachmentRegistry,
    fileLibrary: options.fileLibrary,
    directoryLibrary: options.directoryLibrary,
    systemEventPolicy: options.systemEventPolicy,
    feedbackLedger: options.feedbackLedger,
  });
  return new IVecEngine({
    provider: options.provider,
    staticContext: options.staticContext,
    sessionMemory,
    now: options.now,
    chatTurnRuntime,
    systemEventRuntime,
  });
}

function readyChatContextTurn(): ChatContextPreparedTurn {
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

function ambiguousChatContextTurn(): ChatContextPreparedTurn {
  const context = {
    session: {
      sessionId: "2026-06-27",
      conversationTail: [],
      eventTail: [],
      assetCount: 0,
    },
    focus: { status: "none" as const },
  };
  return {
    status: "ambiguous",
    sessionId: "2026-06-27",
    context,
    message: "I found multiple matching tasks.\n- W-20260627-0001: Upload bug\n- W-20260627-0002: Upload UI",
    candidateCount: 2,
  };
}

function extractStateViewFromProvider(provider: LlmProvider): any {
  const callInput = (provider.generateTurn as any).mock.calls[0]?.[0];
  const userPrompt = callInput.messages.find((message: { role: string }) => message.role === "user").content as string;
  const marker = "State view:\n";
  const start = userPrompt.indexOf(marker);
  if (start < 0) {
    throw new Error("State view section missing from decision prompt.");
  }
  return JSON.parse(userPrompt.slice(start + marker.length).trim());
}

describe("IVecEngine", () => {
  it("is constructible without options", () => {
    const engine = createEngine();
    expect(engine).toBeInstanceOf(IVecEngine);
  });

  it("starts and stops without provider", async () => {
    const engine = createEngine();
    await engine.start();
    await engine.stop();
  });

  it("echoes chat without provider", async () => {
    const onReply = vi.fn();
    const engine = createEngine({ onReply });

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
      const engine = createEngine({
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
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("asks the user when context engine task resolution is ambiguous", async () => {
    const provider = createMockProvider();
    const onReply = vi.fn();
    const chatContextRuntime = createChatContextRuntime(ambiguousChatContextTurn());
    const engine = createEngine({
      onReply,
      provider,
      sessionMemory: createSessionMemory(),
      chatContextRuntime,
      systemEventPolicy: createSystemEventPolicy(),
    });

    await engine.start();
    engine.handleMessage("c1", { type: "chat", content: "upload" });

    await vi.waitFor(() => {
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "feedback",
        content: expect.stringContaining("I found multiple matching tasks"),
      });
    });
    expect(provider.generateTurn).not.toHaveBeenCalled();
    expect(chatContextRuntime.recordAssistantMessage).toHaveBeenCalledWith({
      clientId: "c1",
      turn: expect.objectContaining({
        sessionId: "2026-06-27",
      }),
      message: expect.stringContaining("W-20260627-0001"),
      at: expect.any(String),
    });
    expect(chatContextRuntime.completePreparedRun).not.toHaveBeenCalled();
  });

  it("passes ready context engine context into the loop and commits the completed run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-git-context-"));
    try {
      const provider = createMockProvider();
      const chatContextRuntime = createChatContextRuntime(readyChatContextTurn());
      const engine = createEngine({
        onReply: vi.fn(),
        provider,
        sessionMemory: createSessionMemory(),
        dataDir,
        chatContextRuntime,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Analyze invoice" });

      await vi.waitFor(() => {
        expect(chatContextRuntime.completePreparedRun).toHaveBeenCalled();
      });
      const stateView = extractStateViewFromProvider(provider);
      expect(stateView.context.gitContext.task).toMatchObject({
        workId: "W-20260627-0001",
        open: ["Read invoice"],
      });
      expect(chatContextRuntime.completePreparedRun).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        turn: expect.objectContaining({
          sessionId: "2026-06-27",
          workId: "W-20260627-0001",
          runId: "R-20260627-0001",
        }),
        result: expect.objectContaining({
          content: "mock reply",
        }),
        at: expect.any(String),
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("forwards chat progress events to the client", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-progress-"));
    try {
      const outputPath = join(dataDir, "workspace.txt");
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "call_1",
                  tool: "write_files",
                  input: { files: [{ path: outputPath, content: "workspace inspected" }] },
                  dependsOn: [],
                  purpose: "Record workspace inspection",
                }],
                allowedTools: ["write_files"],
                assertions: [],
              },
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "reply",
              status: "completed",
              message: `I inspected the workspace and saved the result at ${outputPath}.`,
            }),
          }),
      });
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
        onReply,
        provider,
        sessionMemory,
        toolExecutor,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "inspect workspace" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: expect.stringContaining(outputPath),
        });
      });
      const replyContent = findReplyContent(onReply);
      expect(replyContent).not.toContain("Done -");
      expect(replyContent).not.toContain("deterministic verification");
      expect(replyContent).not.toContain("Evidence:");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);

      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "progress",
        content: expect.stringContaining("Step 1"),
        runId: "r1",
      });
      expect(sessionMemory.recordAgentStep as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          runId: "r1",
          phase: "progress",
          summary: expect.stringContaining("Step 1"),
        }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not publish completed task summaries to old session task memory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-task-"));
    try {
      const outputPath = join(dataDir, "config.txt");
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "call_1",
                  tool: "write_files",
                  input: { files: [{ path: outputPath, content: "config=true" }] },
                  dependsOn: [],
                  purpose: "Create config file",
                }],
                allowedTools: ["write_files"],
                assertions: [],
              },
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "reply",
              status: "completed",
              message: `I created the config file at ${outputPath}.`,
            }),
          }),
      });
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
        onReply,
        provider,
        sessionMemory,
        toolExecutor,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "find config files" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: expect.stringContaining(outputPath),
        });
      });
      const replyContent = findReplyContent(onReply);
      expect(replyContent).not.toContain("tool call");
      expect(replyContent).not.toContain("deterministic verification");
      expect(replyContent).not.toContain("Evidence:");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);

    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sends the user response without old task summary queueing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-task-async-"));
    try {
      const outputPath = join(dataDir, "notes.txt");
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "call_1",
                  tool: "write_files",
                  input: { files: [{ path: outputPath, content: "latest notes" }] },
                  dependsOn: [],
                  purpose: "Collect notes",
                }],
                allowedTools: ["write_files"],
                assertions: [],
              },
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "reply",
              status: "completed",
              message: `I collected the notes and saved them at ${outputPath}.`,
            }),
          }),
      });
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();

      const engine = createEngine({
        onReply,
        provider,
        sessionMemory,
        toolExecutor,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "collect notes" });

      await vi.waitFor(() => {
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: expect.stringContaining(outputPath),
        });
      });

    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ignores non-chat messages", () => {
    const onReply = vi.fn();
    const engine = createEngine({ onReply });

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
      const engine = createEngine({ onReply, provider, dataDir });

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

    const engine = createEngine({ provider, sessionMemory });
    await engine.start();

    expect(sessionMemory.setStaticTokenBudget).toHaveBeenCalledWith(expect.any(Number));
    const budget = (sessionMemory.setStaticTokenBudget as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(budget).toBe(0);

    await engine.stop();
  });

  it("processes pulse system_event through recordSystemEvent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
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

      expect(sessionMemory.recordSystemEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ source: "pulse", event: "reminder_due", eventId: "evt-1" }),
      );
      expect(sessionMemory.createWorkRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
        final: true,
      });
      expect(sessionMemory.recordAssistantMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sessionId: "s1",
          content: "mock reply",
          responseKind: "notification",
        }),
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

  it("forwards system event progress events to the client", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-progress-"));
    try {
      const outputPath = join(dataDir, "health.txt");
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "call_1",
                  tool: "write_files",
                  input: { files: [{ path: outputPath, content: "health checked" }] },
                  dependsOn: [],
                  purpose: "Record health check",
                }],
                allowedTools: ["write_files"],
                assertions: [],
              },
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: JSON.stringify({
              kind: "reply",
              status: "completed",
              message: `I checked system health and wrote the result to ${outputPath}.`,
            }),
          }),
      });
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
        onReply,
        provider,
        sessionMemory,
        toolExecutor,
        dataDir,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      await engine.handleSystemEvent("c1", {
        type: "system_event",
        source: "pulse",
        eventName: "reminder_due",
        eventId: "evt-progress-1",
        receivedAt: "2026-03-01T10:00:05.000Z",
        summary: "Reminder due: Health",
        payload: {
          occurrenceId: "occ-progress-1",
          reminderId: "rem-progress-1",
          title: "Health",
          instruction: "Check system health now",
          scheduledFor: "2026-03-01T10:00:00.000Z",
          triggeredAt: "2026-03-01T10:00:05.000Z",
          timezone: "UTC",
        },
      });

      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "progress",
        content: expect.stringContaining("Step 1"),
        runId: "r1",
      });
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: expect.stringContaining(outputPath),
        final: true,
      });
      expect(findReplyContent(onReply, "notification")).not.toContain("deterministic verification");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("processes pulse scheduled task system_event through recordSystemEvent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-task-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
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

      expect(sessionMemory.recordSystemEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ source: "pulse", event: "task_due", eventId: "evt-task-1" }),
      );
      expect(sessionMemory.createWorkRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
        final: true,
      });
      expect(sessionMemory.recordAssistantMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sessionId: "s1",
          content: "mock reply",
          responseKind: "notification",
        }),
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
      const provider = createMockProvider({
        generateTurn: vi.fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>().mockResolvedValue({
          type: "assistant",
          content: JSON.stringify({
            kind: "ask_user",
            question: "mock reply",
            reason: "Approval is required before sending the report.",
          }),
        }),
      });
      const onReply = vi.fn();
      const sessionMemory = createSessionMemory();
      const engine = createEngine({
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
        expect(sessionMemory.recordSystemEvent as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
          "c1",
          expect.objectContaining({ source: "custom-system", event: "task.requested", eventId: "evt-approval-1" }),
        );
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "feedback",
          content: "mock reply",
        });
      });
      expect(sessionMemory.recordAssistantMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sessionId: "s1",
          content: "mock reply",
          responseKind: "feedback",
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

  it("rotates session before recording user input when pre-turn policy requires it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-rotate-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();

      const recordUserMessage = vi.fn().mockReturnValue({ sessionId: "s2", seq: 1 });
      const createSession = vi.fn().mockReturnValue({
        previousSessionId: "s1",
        sessionId: "s2",
        sessionPath: "sessions/s2.md",
      });

      const sessionMemory: SessionMemory = {
        initialize: vi.fn(),
        shutdown: vi.fn(),
        recordUserMessage,
        createWorkRun: vi.fn().mockReturnValue({ sessionId: "s2", runId: "r2", triggerSeq: 1 }),
        createSession,
        recordToolCall: vi.fn(),
        recordToolResult: vi.fn(),
        recordAssistantFinal: vi.fn(),
        recordAssistantMessage: vi.fn(),
        recordRunFailure: vi.fn(),
        recordAgentStep: vi.fn(),
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

      const engine = createEngine({ onReply, provider, sessionMemory, dataDir });
      await engine.start();

      engine.handleMessage("c1", { type: "chat", content: "continue" });

      await vi.waitFor(() => {
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(recordUserMessage).toHaveBeenCalledTimes(1);
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "reply",
          content: "mock reply",
        });
      });

      const rotateOrder = (createSession.mock.invocationCallOrder[0] ?? 0) as number;
      const recordInputOrder = (recordUserMessage.mock.invocationCallOrder[0] ?? 0) as number;
      expect(rotateOrder).toBeGreaterThan(0);
      expect(recordInputOrder).toBeGreaterThan(0);
      expect(rotateOrder).toBeLessThan(recordInputOrder);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
