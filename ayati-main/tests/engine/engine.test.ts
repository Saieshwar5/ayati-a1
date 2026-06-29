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
import type { StaticContext } from "../../src/context/static-context-cache.js";
import type { SystemEventPolicyConfig } from "../../src/ivec/system-event-policy.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type {
  GitMemoryChatContextPreparedTurn,
  GitMemoryChatContextRoutedTurn,
  GitMemoryChatContextRuntime,
} from "../../src/app/git-memory-chat-context-runtime.js";
import type {
  GitMemorySystemEventContextPreparedTurn,
  GitMemorySystemEventContextRoutedTurn,
  GitMemorySystemEventContextRuntime,
} from "../../src/app/git-memory-system-event-context-runtime.js";

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

function createChatContextRuntime(
  routedTurn: GitMemoryChatContextRoutedTurn = readyGitMemoryRoutedTurn(),
): GitMemoryChatContextRuntime {
  const prepared = readyGitMemoryPreparedTurn();
  return {
    prepareUserTurn: vi.fn().mockResolvedValue(prepared),
    routeTaskTurn: vi.fn().mockResolvedValue(routedTurn),
    completeTaskRun: vi.fn().mockResolvedValue({
      taskId: routedTurn.status === "ready" ? routedTurn.taskId : "W-20260627-0001",
      branch: routedTurn.status === "ready" ? routedTurn.branch : "task/W-20260627-0001-analyze-invoice",
      ref: routedTurn.status === "ready" ? routedTurn.ref : "refs/heads/task/W-20260627-0001-analyze-invoice",
      runId: "R-20260627-0001",
      taskCommit: "task-commit",
      event: {
        v: 1,
        seq: 1,
        eventId: "E-20260627-000001",
        type: "run_completed",
        at: "2026-06-27T10:05:00+05:30",
        taskId: routedTurn.status === "ready" ? routedTurn.taskId : "W-20260627-0001",
        runId: "R-20260627-0001",
        branch: routedTurn.status === "ready" ? routedTurn.branch : "task/W-20260627-0001-analyze-invoice",
        commit: "task-commit",
      },
    }),
    recordAssistantMessage: vi.fn().mockResolvedValue({
      v: 1,
      seq: 2,
      messageId: "M-20260627-000002",
      turnId: prepared.turnId,
      role: "assistant",
      at: "2026-06-27T10:05:01+05:30",
      text: "mock reply",
    }),
    buildActiveContext: vi.fn().mockResolvedValue(routedTurn.context),
  };
}

function createSystemEventContextRuntime(
  routedTurn: GitMemorySystemEventContextRoutedTurn = readyGitMemorySystemEventRoutedTurn(),
): GitMemorySystemEventContextRuntime {
  const prepared = readyGitMemorySystemEventPreparedTurn();
  return {
    prepareSystemEventTurn: vi.fn().mockResolvedValue(prepared),
    routeTaskTurn: vi.fn().mockResolvedValue(routedTurn),
    completeTaskRun: vi.fn().mockResolvedValue({
      taskId: routedTurn.status === "ready" ? routedTurn.taskId : "W-20260627-0001",
      branch: routedTurn.status === "ready" ? routedTurn.branch : "task/W-20260627-0001-analyze-invoice",
      ref: routedTurn.status === "ready" ? routedTurn.ref : "refs/heads/task/W-20260627-0001-analyze-invoice",
      runId: "R-20260627-0001",
      taskCommit: "task-commit",
      event: {
        v: 1,
        seq: 1,
        eventId: "E-20260627-000001",
        type: "run_completed",
        at: "2026-06-27T10:05:00+05:30",
        taskId: routedTurn.status === "ready" ? routedTurn.taskId : "W-20260627-0001",
        runId: "R-20260627-0001",
        branch: routedTurn.status === "ready" ? routedTurn.branch : "task/W-20260627-0001-analyze-invoice",
        commit: "task-commit",
      },
    }),
    recordAssistantMessage: vi.fn().mockResolvedValue({
      v: 1,
      seq: 2,
      messageId: "M-20260627-000002",
      turnId: prepared.turnId,
      role: "assistant",
      at: "2026-06-27T10:05:01+05:30",
      text: "mock reply",
    }),
    buildActiveContext: vi.fn().mockResolvedValue(routedTurn.context),
  };
}

type TestEngineOptions =
  & Omit<
    Partial<CreateChatTurnRuntimeOptions & CreateSystemEventRuntimeOptions>,
    "chatContextRuntime" | "systemEventContextRuntime"
  >
  & {
    chatContextRuntime?: GitMemoryChatContextRuntime;
    systemEventContextRuntime?: GitMemorySystemEventContextRuntime;
  };

function createEngine(options: TestEngineOptions = {}): IVecEngine {
  const chatContextRuntime = options.chatContextRuntime ?? createChatContextRuntime();
  const systemEventContextRuntime = options.systemEventContextRuntime ?? createSystemEventContextRuntime();
  const chatTurnRuntime = createChatTurnRuntime({
    onReply: options.onReply,
    provider: options.provider,
    staticContext: options.staticContext,
    toolExecutor: options.toolExecutor,
    skillActivationManager: options.skillActivationManager,
    toolWorkingSetManager: options.toolWorkingSetManager,
    loopConfig: options.loopConfig,
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
    systemEventContextRuntime,
    toolExecutor: options.toolExecutor,
    skillActivationManager: options.skillActivationManager,
    toolWorkingSetManager: options.toolWorkingSetManager,
    loopConfig: options.loopConfig,
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
    now: options.now,
    chatTurnRuntime,
    systemEventRuntime,
  });
}

function readyGitMemoryPreparedTurn(): GitMemoryChatContextPreparedTurn {
  return {
    status: "ready",
    sessionId: "S-20260627-local",
    repoPath: "/tmp/ayati-git-memory/S-20260627-local",
    initialized: false,
    messageSeq: 1,
    messageId: "M-20260627-000001",
    turnId: "T-20260627-000001",
    context: {
      session: {
        sessionId: "S-20260627-local",
        conversationTail: [],
        eventTail: [],
        taskCount: 1,
      },
      focus: { status: "none" },
    },
  };
}

function readyGitMemorySystemEventPreparedTurn(): GitMemorySystemEventContextPreparedTurn {
  return {
    status: "ready",
    sessionId: "S-20260627-local",
    repoPath: "/tmp/ayati-git-memory/S-20260627-local",
    initialized: false,
    messageSeq: 1,
    messageId: "M-20260627-000001",
    turnId: "T-20260627-000001",
    context: {
      session: {
        sessionId: "S-20260627-local",
        conversationTail: [],
        eventTail: [],
        taskCount: 1,
      },
      focus: { status: "none" },
    },
  };
}

function readyGitMemoryRoutedTurn(): Extract<GitMemoryChatContextRoutedTurn, { status: "ready" }> {
  const context = {
    session: {
      sessionId: "S-20260627-local",
      conversationTail: [{
        v: 1,
        seq: 1,
        messageId: "M-20260627-000001",
        turnId: "T-20260627-000001",
        role: "user" as const,
        at: "2026-06-27T10:00:00+05:30",
        text: "Analyze invoice",
      }],
      eventTail: [],
      taskCount: 1,
    },
    focus: {
      status: "active" as const,
      taskId: "W-20260627-0001",
      branch: "task/W-20260627-0001-analyze-invoice",
      ref: "refs/heads/task/W-20260627-0001-analyze-invoice",
    },
    task: {
      ref: "refs/heads/task/W-20260627-0001-analyze-invoice",
      taskId: "W-20260627-0001",
      branch: "task/W-20260627-0001-analyze-invoice",
      title: "Analyze invoice",
      objective: "Analyze invoice",
      status: "in_progress",
      summary: "Analyze invoice",
      completed: [],
      open: ["Read invoice"],
      blockers: [],
      facts: [],
      next: "Read invoice",
      recentRuns: [],
      recentCommits: [],
    },
  };
  return {
    status: "ready",
    mode: "continue_active_task",
    sessionId: "S-20260627-local",
    taskId: "W-20260627-0001",
    runId: "R-20260627-0001",
    branch: "task/W-20260627-0001-analyze-invoice",
    ref: "refs/heads/task/W-20260627-0001-analyze-invoice",
    conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
    confidence: "deterministic",
    reason: "test fixture",
    context,
    harnessContext: {
      contextEngine: {
        session: {
          sessionId: "S-20260627-local",
          conversationTail: [{
            seq: 1,
            role: "user",
            at: "2026-06-27T10:00:00+05:30",
            text: "Analyze invoice",
          }],
          eventTail: [],
          assetCount: 0,
        },
        focus: {
          status: "active",
          ref: "refs/heads/task/W-20260627-0001-analyze-invoice",
          workId: "W-20260627-0001",
        },
        task: {
          ref: "refs/heads/task/W-20260627-0001-analyze-invoice",
          workId: "W-20260627-0001",
          title: "Analyze invoice",
          objective: "Analyze invoice",
          status: "in_progress",
          completed: [],
          open: ["Read invoice"],
          blockers: [],
          facts: [],
          assets: [],
          recentRuns: [],
          recentCommits: [],
          recentEvidence: [],
        },
      },
    },
  };
}

function readyGitMemorySystemEventRoutedTurn(): Extract<GitMemorySystemEventContextRoutedTurn, { status: "ready" }> {
  return readyGitMemoryRoutedTurn();
}

function ambiguousGitMemoryRoutedTurn(): Extract<GitMemoryChatContextRoutedTurn, { status: "ambiguous" }> {
  const context = {
    session: {
      sessionId: "S-20260627-local",
      conversationTail: [],
      eventTail: [],
      taskCount: 2,
    },
    focus: { status: "none" as const },
  };
  return {
    status: "ambiguous",
    sessionId: "S-20260627-local",
    candidates: [
      {
        taskId: "W-20260627-0001",
        branch: "task/W-20260627-0001-upload-bug",
        ref: "refs/heads/task/W-20260627-0001-upload-bug",
        title: "Upload bug",
        status: "in_progress",
        score: 55,
        reasons: ["task title token matched: upload"],
      },
      {
        taskId: "W-20260627-0002",
        branch: "task/W-20260627-0002-upload-ui",
        ref: "refs/heads/task/W-20260627-0002-upload-ui",
        title: "Upload UI",
        status: "in_progress",
        score: 55,
        reasons: ["task title token matched: upload"],
      },
    ],
    reason: "multiple existing tasks matched partially",
    context,
    harnessContext: {
      contextEngine: {
        session: {
          sessionId: "S-20260627-local",
          conversationTail: [],
          eventTail: [],
          assetCount: 0,
        },
        focus: { status: "none" },
      },
    },
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
      const engine = createEngine({
        onReply,
        provider,
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
    const chatContextRuntime = createChatContextRuntime(ambiguousGitMemoryRoutedTurn());
    const engine = createEngine({
      onReply,
      provider,
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
        sessionId: "S-20260627-local",
      }),
      message: expect.stringContaining("W-20260627-0001"),
      at: expect.any(String),
    });
    expect(chatContextRuntime.completeTaskRun).not.toHaveBeenCalled();
  });

  it("passes ready context engine context into the loop and commits the completed run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-git-context-"));
    try {
      const provider = createMockProvider();
      const chatContextRuntime = createChatContextRuntime();
      const engine = createEngine({
        onReply: vi.fn(),
        provider,
        dataDir,
        chatContextRuntime,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Analyze invoice" });

      await vi.waitFor(() => {
        expect(chatContextRuntime.completeTaskRun).toHaveBeenCalled();
      });
      const stateView = extractStateViewFromProvider(provider);
      expect(stateView.context.gitContext.task).toMatchObject({
        workId: "W-20260627-0001",
        open: ["Read invoice"],
      });
      expect(chatContextRuntime.completeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        turn: expect.objectContaining({
          sessionId: "S-20260627-local",
          messageSeq: 1,
        }),
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
        conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
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
      const engine = createEngine({
        onReply,
        provider,
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
        runId: "R-20260627-0001",
      });
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
      const engine = createEngine({
        onReply,
        provider,
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

      const engine = createEngine({
        onReply,
        provider,
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

  it("processes pulse system_event through git-memory system context", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const systemEventContextRuntime = createSystemEventContextRuntime();
      const engine = createEngine({
        onReply,
        provider,
        systemEventContextRuntime,
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

      expect(systemEventContextRuntime.prepareSystemEventTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        systemMessage: expect.stringContaining("System event: pulse/reminder_due"),
        at: "2026-03-01T10:00:05.000Z",
      }));
      expect(systemEventContextRuntime.routeTaskTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        userMessage: expect.stringContaining("Reminder due: Health"),
      }));
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
        final: true,
      });
      expect(systemEventContextRuntime.completeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
        result: expect.objectContaining({ content: "mock reply" }),
      }));
      expect(systemEventContextRuntime.recordAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        message: "mock reply",
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
      }));
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
      const engine = createEngine({
        onReply,
        provider,
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
        runId: "R-20260627-0001",
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

  it("processes pulse scheduled task system_event through git-memory system context", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-eng-system-task-event-"));
    try {
      const provider = createMockProvider();
      const onReply = vi.fn();
      const systemEventContextRuntime = createSystemEventContextRuntime();
      const engine = createEngine({
        onReply,
        provider,
        systemEventContextRuntime,
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

      expect(systemEventContextRuntime.prepareSystemEventTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        systemMessage: expect.stringContaining("System event: pulse/task_due"),
      }));
      expect(systemEventContextRuntime.routeTaskTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        userMessage: expect.stringContaining("check_system_health"),
      }));
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "mock reply",
        final: true,
      });
      expect(systemEventContextRuntime.completeTaskRun).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
        result: expect.objectContaining({ content: "mock reply" }),
      }));
      expect(systemEventContextRuntime.recordAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        message: "mock reply",
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
      }));
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
      const systemEventContextRuntime = createSystemEventContextRuntime();
      const engine = createEngine({
        onReply,
        provider,
        systemEventContextRuntime,
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
        expect(onReply).toHaveBeenCalledWith("c1", {
          type: "feedback",
          content: "mock reply",
        });
      });
      expect(systemEventContextRuntime.prepareSystemEventTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        systemMessage: expect.stringContaining("System event: custom-system/task.requested"),
      }));
      expect(systemEventContextRuntime.routeTaskTurn).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        userMessage: expect.stringContaining("send_report"),
      }));
      expect(systemEventContextRuntime.recordAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        clientId: "c1",
        message: "mock reply",
        taskId: "W-20260627-0001",
        runId: "R-20260627-0001",
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
