import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { SystemEventPolicyConfig } from "../../src/ivec/system-event-policy.js";
import type {
  GitContextPreparedTurn,
  GitContextRuntime,
} from "../../src/app/git-context-runtime.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { nativeDecisionFixture } from "../ivec/native-decision-fixture.js";

const originalWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env["AYATI_WORKSPACE_DIR"];
  } else {
    process.env["AYATI_WORKSPACE_DIR"] = originalWorkspaceDir;
  }
});

function makeTmpDir(prefix = "ayati-engine-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  process.env["AYATI_WORKSPACE_DIR"] = path;
  return path;
}

function createProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map(nativeDecisionFixture);
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: { jsonObject: true, jsonSchema: true },
    },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async (): Promise<LlmTurnOutput> => {
      const response = queue.shift();
      if (!response) throw new Error("No queued provider response.");
      return response;
    }),
  };
}

function createThrowingProvider(error: Error): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn().mockRejectedValue(error),
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
    rules: [{
      source: "pulse",
      eventClass: "trigger_fired",
      createdBy: "user",
      mode: "auto_execute_notify",
    }],
  };
}

function createPreparedTurn(input: {
  role: "user" | "system_event";
  runId?: string;
  messageSeq?: number;
}): GitContextPreparedTurn {
  const runId = input.runId ?? "R-20260719-0001";
  const messageSeq = input.messageSeq ?? 1;
  const sessionId = "S-20260719-local";
  const conversationId = `C-${runId}`;
  return {
    status: "ready",
    sessionId,
    repoPath: "/tmp/ayati-git-context/S-20260719-local",
    initialized: false,
    messageSeq,
    currentMessageId: `M-${runId}`,
    currentMessageSessionSequence: messageSeq,
    conversationId,
    inputRole: input.role,
    run: {
      runId,
      sessionId,
      conversationId,
      triggerSeq: messageSeq,
    },
    context: {
      session: {
        meta: { sessionId, assetCount: 0 },
        conversationTail: [],
        activityTail: [],
      },
      pendingTurn: {
        fromSeq: messageSeq,
        toSeq: messageSeq,
        text: "",
        at: "2026-07-19T10:00:00.000Z",
        routingStatus: "unbound",
        runId,
      },
      focus: { status: "none" },
    },
  };
}

function createContextRuntime(prepared: GitContextPreparedTurn): GitContextRuntime {
  const prepareUserTurn = vi.fn(async (
    input: Parameters<GitContextRuntime["prepareUserTurn"]>[0],
  ) => {
    setCurrentMessage(prepared, input.userMessage, input.at, "user");
    return prepared;
  });
  const prepareSystemEventTurn = vi.fn(async (
    input: Parameters<GitContextRuntime["prepareSystemEventTurn"]>[0],
  ) => {
    setCurrentMessage(prepared, input.systemMessage, input.at, "system");
    return prepared;
  });
  const finalizeRun = vi.fn(async (
    input: Parameters<GitContextRuntime["finalizeRun"]>[0],
  ) => {
    const taskBound = Boolean(input.taskCompletion);
    return {
      run: {
        runId: prepared.run.runId,
        sessionId: prepared.sessionId,
        conversationId: prepared.conversationId,
        ...(taskBound ? {
          taskBinding: {
            taskId: "T-20260719-0001",
            taskRequestId: "REQ-20260719-0001",
            boundAt: "2026-07-19T10:00:01.000Z",
          },
        } : {}),
        status: input.outcome,
        trigger: prepared.inputRole === "user" ? "user" : "system_event",
        startedAt: "2026-07-19T10:00:00.000Z",
        completedAt: input.at,
        stopReason: input.stopReason,
        stepCount: 0,
      },
      conversation: {
        conversationId: prepared.conversationId,
        sessionId: prepared.sessionId,
        sequence: prepared.messageSeq,
        filePath: `conversations/${prepared.messageSeq}.md`,
        status: "committed",
      },
      persistence: {
        database: "saved",
        materialization: "not_requested",
        git: taskBound ? "not_committed" : "not_required",
      },
      materialization: { status: "not_requested" },
      commit: taskBound
        ? {
            status: "no_change",
            taskId: "T-20260719-0001",
            taskRequestId: "REQ-20260719-0001",
            headBefore: "a".repeat(40),
            headAfter: "a".repeat(40),
          }
        : { status: "not_required" },
    };
  });
  return {
    warmActiveContext: vi.fn().mockResolvedValue(undefined),
    prepareUserTurn,
    prepareSystemEventTurn,
    finalizeRun,
    recordRunStep: vi.fn().mockResolvedValue(null),
    recordSessionAttachments: vi.fn().mockResolvedValue(null),
    buildActiveContext: vi.fn().mockResolvedValue(prepared.context),
  };
}

function setCurrentMessage(
  prepared: GitContextPreparedTurn,
  text: string,
  at: string,
  role: "user" | "system",
): void {
  prepared.context.session.conversationTail = [{
    seq: prepared.currentMessageSessionSequence,
    messageId: prepared.currentMessageId,
    conversationId: prepared.conversationId,
    conversationSequence: prepared.messageSeq,
    segmentSequence: 1,
    role,
    at,
    text,
  }];
  if (prepared.context.pendingTurn) {
    prepared.context.pendingTurn.text = text;
    prepared.context.pendingTurn.at = at;
  }
}

type TestEngineOptions =
  & Omit<
    Partial<CreateChatTurnRuntimeOptions & CreateSystemEventRuntimeOptions>,
    "chatContextRuntime" | "systemEventContextRuntime"
  >
  & {
    chatContextRuntime?: GitContextRuntime;
    systemEventContextRuntime?: GitContextRuntime;
  };

function createEngine(options: TestEngineOptions = {}): IVecEngine {
  const chatContextRuntime = options.chatContextRuntime
    ?? createContextRuntime(createPreparedTurn({ role: "user" }));
  const systemEventContextRuntime = options.systemEventContextRuntime
    ?? createContextRuntime(createPreparedTurn({ role: "system_event" }));
  const provider = options.provider ? withNativeDecisions(options.provider) : undefined;
  const chatTurnRuntime = createChatTurnRuntime({
    onReply: options.onReply,
    provider,
    toolExecutor: options.toolExecutor,
    loopConfig: options.loopConfig,
    now: options.now,
    dataDir: options.dataDir,
    feedbackLedger: options.feedbackLedger,
    chatContextRuntime,
  });
  const systemEventRuntime = createSystemEventRuntime({
    onReply: options.onReply,
    provider,
    systemEventContextRuntime,
    toolExecutor: options.toolExecutor,
    loopConfig: options.loopConfig,
    now: options.now,
    dataDir: options.dataDir,
    systemEventPolicy: options.systemEventPolicy,
    feedbackLedger: options.feedbackLedger,
  });
  return new IVecEngine({
    provider,
    now: options.now,
    chatTurnRuntime,
    systemEventRuntime,
  });
}

function withNativeDecisions(provider: LlmProvider): LlmProvider {
  return {
    ...provider,
    async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
      const turn = await provider.generateTurn(input);
      return turn.type === "assistant" ? nativeDecisionFixture(turn.content) : turn;
    },
  };
}

function createReadTool(): ToolDefinition {
  return {
    name: "read_files",
    description: "Read a fixture file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      domain: "filesystem",
      readOnly: true,
      mutatesWorkspace: false,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: true,
      retrySafe: true,
      longRunning: false,
    },
    async execute() {
      return { ok: true, output: "upload handling lives in src/upload.ts" };
    },
  };
}

function createTaskBindingTool(
  prepared: GitContextPreparedTurn,
  workingDirectory: string,
): ToolDefinition {
  return {
    name: "git_context_create_task",
    description: "Bind the current run to a fixture task.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "createReason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        createReason: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    annotations: {
      domain: "git_context",
      readOnly: false,
      mutatesWorkspace: true,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: false,
      retrySafe: false,
      longRunning: false,
    },
    async execute() {
      const taskId = "T-20260719-0001";
      const branch = "task/T-20260719-0001-one-run";
      const contextEngine = {
        ...prepared.context,
        pendingTurn: {
          ...prepared.context.pendingTurn!,
          routingStatus: "bound" as const,
          workId: taskId,
          branch,
          runId: prepared.run.runId,
        },
        focus: {
          status: "active" as const,
          ref: `refs/heads/${branch}`,
          workId: taskId,
        },
        task: {
          workingDirectory,
          ref: `refs/heads/${branch}`,
          workId: taskId,
          title: "One run integration",
          objective: "Create the requested file.",
          status: "active",
          completed: [],
          open: ["Create the requested file."],
          blockers: [],
          facts: [],
          next: "Create the requested file.",
          assets: [],
          recentRuns: [],
          recentCommits: [],
          recentEvidence: [],
        },
      };
      return {
        ok: true,
        output: "Bound the existing run to a new task.",
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "GIT_CONTEXT_TURN_TASK_CREATED",
          message: "Bound the existing run to a new task.",
          structuredContent: {
            status: "ready",
            mode: "created",
            sessionId: prepared.sessionId,
            taskId,
            taskRequestId: "REQ-20260719-0001",
            taskRequestStatus: "active",
            taskRequestCreated: true,
            requestDecision: "initial",
            taskCreated: true,
            branch,
            workingDirectory,
            taskHead: "a".repeat(40),
            runId: prepared.run.runId,
            harnessContext: { contextEngine },
          },
        },
      };
    },
  };
}

function pulseEvent(eventId = "evt-1") {
  return {
    type: "system_event" as const,
    source: "pulse",
    eventName: "reminder_due",
    eventId,
    receivedAt: "2026-07-19T10:00:05.000Z",
    summary: "Reminder due: Review health notes",
    payload: {
      occurrenceId: `occ-${eventId}`,
      reminderId: "rem-1",
      title: "Review health notes",
      instruction: "Review health notes now",
      scheduledFor: "2026-07-19T10:00:00.000Z",
      triggeredAt: "2026-07-19T10:00:05.000Z",
      timezone: "UTC",
    },
  };
}

describe("IVecEngine one-run integration", () => {
  it("is constructible and starts without a provider", async () => {
    const engine = createEngine();
    expect(engine).toBeInstanceOf(IVecEngine);
    await engine.start();
    await engine.stop();
  });

  it("prepares and finalizes one zero-step echo run before dispatch", async () => {
    const onReply = vi.fn();
    const runtime = createContextRuntime(createPreparedTurn({ role: "user" }));
    const engine = createEngine({ onReply, chatContextRuntime: runtime });

    engine.handleMessage("c1", { type: "chat", content: "hello" });

    await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
    expect(runtime.prepareUserTurn).toHaveBeenCalledOnce();
    expect(runtime.recordRunStep).not.toHaveBeenCalled();
    expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "done",
      stopReason: "completed",
      assistantResponse: 'Received: "hello"',
    }));
    expect(vi.mocked(runtime.finalizeRun).mock.invocationCallOrder[0])
      .toBeLessThan(onReply.mock.invocationCallOrder[0]!);
    expect(onReply).toHaveBeenCalledWith("c1", {
      type: "reply",
      content: 'Received: "hello"',
      runId: "R-20260719-0001",
      commitStatus: "not_required",
    });
  });

  it("finalizes a provider direct reply on the prepared run", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Upload handling is in src/upload.ts." },
      ]);
      const onReply = vi.fn();
      const runtime = createContextRuntime(createPreparedTurn({ role: "user", runId: "R-direct" }));
      const engine = createEngine({ onReply, provider, dataDir, chatContextRuntime: runtime });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Where is upload handling?" });

      await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
      expect(provider.generateTurn).toHaveBeenCalledOnce();
      expect(runtime.recordRunStep).not.toHaveBeenCalled();
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        turn: expect.objectContaining({ run: expect.objectContaining({ runId: "R-direct" }) }),
        outcome: "done",
        stopReason: "completed",
      }));
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "Upload handling is in src/upload.ts.",
        runId: "R-direct",
        commitStatus: "not_required",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists focused clarification as needs_user_input", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Which file should I inspect? Please provide the file path." },
      ]);
      const onReply = vi.fn();
      const runtime = createContextRuntime(createPreparedTurn({ role: "user", runId: "R-clarify" }));
      const engine = createEngine({ onReply, provider, dataDir, chatContextRuntime: runtime });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Inspect it" });

      await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
      expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
      }));
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("taskCompletion");
      expect(onReply).toHaveBeenCalledWith("c1", expect.objectContaining({
        type: "reply",
        content: "Which file should I inspect? Please provide the file path.",
        runId: "R-clarify",
        commitStatus: "not_required",
      }));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an unbound mutation without execution or step replay", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "must-not-exist.txt");
    try {
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "stale-write",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "unsafe" }] },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        { kind: "reply", status: "completed", message: "I need to bind this run before mutation." },
      ]);
      const onReply = vi.fn();
      const runtime = createContextRuntime(createPreparedTurn({ role: "user", runId: "R-unbound-write" }));
      const engine = createEngine({
        onReply,
        provider,
        dataDir,
        chatContextRuntime: runtime,
        toolExecutor: createToolExecutor([writeFilesTool]),
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Create a file" });

      await vi.waitFor(() => {
        expect(onReply.mock.calls.some(([, response]) => (
          response as { type?: string }
        ).type === "reply")).toBe(true);
      });
      expect(existsSync(outputPath)).toBe(false);
      expect(runtime.recordRunStep).not.toHaveBeenCalled();
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("binds and mutates on the same run, then acknowledges finalization", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "one-run.txt");
    const prepared = createPreparedTurn({ role: "user", runId: "R-route-and-write" });
    const runtime = createContextRuntime(prepared);
    const routeTool = createTaskBindingTool(prepared, dataDir);
    const provider = createProvider([
      {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "bind-task",
            tool: "git_context_create_task",
            input: {
              title: "One run file",
              objective: "Create one-run.txt",
              createReason: "No task owns this deliverable.",
            },
            dependsOn: [],
            purpose: "Bind the durable work",
          }],
          allowedTools: ["git_context_create_task"],
          assertions: [],
        },
      },
      {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "write-after-binding",
            tool: "write_files",
            input: { files: [{ path: outputPath, content: "same durable run" }] },
            dependsOn: [],
            purpose: "Create the file after binding",
          }],
          allowedTools: ["write_files"],
          assertions: [],
        },
      },
      {
        kind: "task_completion",
        request: { summary: "Created and verified one-run.txt.", assets: [] },
      },
      { kind: "reply", status: "completed", message: "Created one-run.txt." },
    ]);
    const onReply = vi.fn();
    const engine = createEngine({
      onReply,
      provider,
      dataDir,
      chatContextRuntime: runtime,
      toolExecutor: createToolExecutor([routeTool, writeFilesTool]),
    });

    try {
      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Create one-run.txt" });

      await vi.waitFor(() => {
        expect(onReply.mock.calls.some(([, response]) => (
          response as { type?: string }
        ).type === "reply")).toBe(true);
      });
      expect(readFileSync(outputPath, "utf8")).toBe("same durable run");
      expect(runtime.recordRunStep).toHaveBeenCalledTimes(2);
      for (const [input] of vi.mocked(runtime.recordRunStep).mock.calls) {
        expect(input.turn?.run.runId).toBe("R-route-and-write");
        expect(input.record.runId).toBe("R-route-and-write");
      }
      expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        turn: expect.objectContaining({ run: expect.objectContaining({ runId: "R-route-and-write" }) }),
        outcome: "done",
        stopReason: "completed",
        taskCompletion: expect.objectContaining({ accepted: true }),
      }));
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "reply",
        content: "Created one-run.txt.",
        runId: "R-route-and-write",
        commitStatus: "no_change",
      });
      const terminalReplyIndex = onReply.mock.calls.findIndex(([, response]) => (
        response as { type?: string }
      ).type === "reply");
      expect(vi.mocked(runtime.finalizeRun).mock.invocationCallOrder[0])
        .toBeLessThan(onReply.mock.invocationCallOrder[terminalReplyIndex]!);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not send a successful terminal envelope when finalization fails", async () => {
    const dataDir = makeTmpDir();
    try {
      const runtime = createContextRuntime(createPreparedTurn({ role: "user", runId: "R-finalize-fails" }));
      vi.mocked(runtime.finalizeRun).mockRejectedValue(new Error("commit identity is uncertain"));
      const onReply = vi.fn();
      const engine = createEngine({
        onReply,
        provider: createProvider([{ kind: "reply", status: "completed", message: "Finished." }]),
        dataDir,
        chatContextRuntime: runtime,
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Finish it" });

      await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "error",
        content: "Failed to generate a response.",
      });
      expect(onReply.mock.calls.some(([, response]) => (
        response as { type?: string; commitStatus?: string }
      ).type === "reply" || (
        response as { commitStatus?: string }
      ).commitStatus === "committed")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finalizes an unbound system event exactly once", async () => {
    const dataDir = makeTmpDir();
    try {
      const runtime = createContextRuntime(createPreparedTurn({
        role: "system_event",
        runId: "R-system-direct",
      }));
      const onReply = vi.fn();
      const engine = createEngine({
        onReply,
        provider: createProvider([
          { kind: "reply", status: "completed", message: "Health notes are current." },
        ]),
        dataDir,
        systemEventContextRuntime: runtime,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      await engine.handleSystemEvent("c1", pulseEvent("system-direct"));

      expect(runtime.prepareSystemEventTurn).toHaveBeenCalledOnce();
      expect(runtime.recordRunStep).not.toHaveBeenCalled();
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "done",
        stopReason: "completed",
      }));
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("taskCompletion");
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "notification",
        content: "Health notes are current.",
        final: true,
        runId: "R-system-direct",
        commitStatus: "not_required",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records an observational system-event step on its prepared run", async () => {
    const dataDir = makeTmpDir();
    try {
      const runtime = createContextRuntime(createPreparedTurn({
        role: "system_event",
        runId: "R-system-read",
      }));
      const readTool = createReadTool();
      const engine = createEngine({
        provider: createProvider([
          {
            kind: "act",
            action: {
              mode: "single",
              calls: [{
                id: "read-health",
                tool: "read_files",
                input: { path: "health-notes.md" },
                dependsOn: [],
                purpose: "Inspect health notes",
              }],
              allowedTools: ["read_files"],
              assertions: [],
            },
          },
          { kind: "reply", status: "completed", message: "Health notes are current." },
        ]),
        toolExecutor: createToolExecutor([readTool]),
        dataDir,
        systemEventContextRuntime: runtime,
        systemEventPolicy: createSystemEventPolicy(),
      });

      await engine.start();
      await engine.handleSystemEvent("c1", pulseEvent("system-read"));

      expect(runtime.recordRunStep).toHaveBeenCalledOnce();
      expect(runtime.recordRunStep).toHaveBeenCalledWith(expect.objectContaining({
        turn: expect.objectContaining({ run: expect.objectContaining({ runId: "R-system-read" }) }),
        record: expect.objectContaining({
          runId: "R-system-read",
          step: 1,
          toolCalls: [expect.objectContaining({
            callId: "read-health",
            tool: "read_files",
            status: "success",
          })],
        }),
      }));
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("taskCompletion");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finalizes a provider crash as failed before sending the error", async () => {
    const dataDir = makeTmpDir();
    try {
      const runtime = createContextRuntime(createPreparedTurn({ role: "user", runId: "R-provider-fails" }));
      const onReply = vi.fn();
      const engine = createEngine({
        onReply,
        provider: createThrowingProvider(new Error("API down")),
        dataDir,
        chatContextRuntime: runtime,
      });

      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "hello" });

      await vi.waitFor(() => expect(onReply).toHaveBeenCalledOnce());
      expect(runtime.finalizeRun).toHaveBeenCalledOnce();
      expect(runtime.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "failed",
        stopReason: "failed",
        validation: "failed",
      }));
      expect(vi.mocked(runtime.finalizeRun).mock.invocationCallOrder[0])
        .toBeLessThan(onReply.mock.invocationCallOrder[0]!);
      expect(onReply).toHaveBeenCalledWith("c1", {
        type: "error",
        content: "Failed to generate a response.",
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
