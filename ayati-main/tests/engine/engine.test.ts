import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContextDatabase,
  SqliteContextEngineService,
} from "ayati-context-engine";
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
  ContextEnginePreparedTurn,
  ContextEngineRuntime,
} from "../../src/app/context-engine-runtime.js";
import { createContextEngineRuntime } from "../../src/app/context-engine-runtime.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";
import { nativeDecisionFixture } from "../ivec/native-decision-fixture.js";

const originalAyatiRootDir = process.env["AYATI_ROOT_DIR"];

afterEach(() => {
  if (originalAyatiRootDir === undefined) {
    delete process.env["AYATI_ROOT_DIR"];
  } else {
    process.env["AYATI_ROOT_DIR"] = originalAyatiRootDir;
  }
});

function makeTmpDir(prefix = "ayati-engine-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  process.env["AYATI_ROOT_DIR"] = path;
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
}): ContextEnginePreparedTurn {
  const runId = input.runId ?? "R-20260719-0001";
  const messageSeq = input.messageSeq ?? 1;
  const streamId = "S-20260719-local";
  const context = contextEngineFixture({ streamId, runId, message: "" });
  context.agentStream.meta.lastMessageSequence = messageSeq;
  context.agentStream.recentMessages[0]!.sequence = messageSeq;
  context.agentStream.recentMessages[0]!.messageId = `M-${runId}`;
  context.agentStream.recentMessages[0]!.role = input.role;
  context.current.inputSeq = messageSeq;
  context.current.runId = runId;
  return {
    status: "ready",
    streamId,
    streamCreated: false,
    messageSequence: messageSeq,
    currentMessageId: `M-${runId}`,
    inputRole: input.role,
    run: {
      runId,
      streamId,
      triggerSeq: messageSeq,
    },
    context,
  };
}

function createContextRuntime(prepared: ContextEnginePreparedTurn): ContextEngineRuntime {
  const prepareUserTurn = vi.fn(async (
    input: Parameters<ContextEngineRuntime["prepareUserTurn"]>[0],
  ) => {
    setCurrentMessage(prepared, input.userMessage, input.at, "user");
    return prepared;
  });
  const prepareSystemEventTurn = vi.fn(async (
    input: Parameters<ContextEngineRuntime["prepareSystemEventTurn"]>[0],
  ) => {
    setCurrentMessage(prepared, input.systemMessage, input.at, "system_event");
    return prepared;
  });
  const finalizeRun = vi.fn(async (
    input: Parameters<ContextEngineRuntime["finalizeRun"]>[0],
  ) => {
    const workstreamBound = Boolean(input.workstreamCompletion);
    return {
      run: {
        runId: prepared.run.runId,
        streamId: prepared.streamId,
        ...(workstreamBound ? {
          workstreamBinding: {
            workstreamId: "W-20260719-0001",
            requestId: "R-0001",
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
      assistantMessage: {
        messageId: `M-assistant-${prepared.run.runId}`,
        streamId: prepared.streamId,
        runId: prepared.run.runId,
        sequence: prepared.messageSequence + 1,
        role: "assistant" as const,
        content: input.assistantResponse,
        contentHash: "sha256:assistant",
        at: input.at,
      },
      observationRevision: "observations:finalized",
      resourceEffects: { status: "none", events: [] },
      workstreamContextCommit: workstreamBound
        ? {
            status: "no_change",
            workstreamId: "W-20260719-0001",
            requestId: "R-0001",
            headBefore: "a".repeat(40),
            headAfter: "a".repeat(40),
          }
        : { status: "not_required" },
    };
  });
  const checkpointPlan = vi.fn().mockResolvedValue({
    planId: "PLAN-1",
    streamId: prepared.streamId,
    selectedMessages: [],
    exactTail: prepared.context.agentStream.recentMessages,
    estimatedCheckpointTokens: 1_200,
    triggered: false,
  });
  const checkpointCommit = vi.fn();
  return {
    prepareUserTurn,
    prepareSystemEventTurn,
    finalizeRun,
    recordRunStep: vi.fn().mockResolvedValue(null),
    contextCheckpointCoordinator: vi.fn().mockReturnValue({
      plan: checkpointPlan,
      commit: checkpointCommit,
    }),
  };
}

function setCurrentMessage(
  prepared: ContextEnginePreparedTurn,
  text: string,
  at: string,
  role: "user" | "system_event",
): void {
  const message = {
    messageId: prepared.currentMessageId,
    streamId: prepared.streamId,
    runId: prepared.run.runId,
    sequence: prepared.messageSequence,
    role,
    content: text,
    contentHash: `sha256:${prepared.currentMessageId}`,
    at,
  };
  prepared.context.agentStream.recentMessages = [message];
  prepared.context.current.inputSeq = prepared.messageSequence;
  prepared.context.current.runId = prepared.run.runId;
}

type TestEngineOptions =
  & Omit<
    Partial<CreateChatTurnRuntimeOptions & CreateSystemEventRuntimeOptions>,
    "chatContextRuntime" | "systemEventContextRuntime"
  >
  & {
    chatContextRuntime?: ContextEngineRuntime;
    systemEventContextRuntime?: ContextEngineRuntime;
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
    contextEngineService: options.contextEngineService,
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
    contextEngineService: options.contextEngineService,
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
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("workstreamCompletion");
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
    const outputPath = join(dataDir, "workspace", "must-not-exist.txt");
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

  it("resolves in isolation, mutates on the same run, then acknowledges finalization", async () => {
    const dataDir = makeTmpDir();
    const workingDirectory = join(dataDir, "workspace");
    const outputPath = join(workingDirectory, "one-run.txt");
    const database = await ContextDatabase.open({ path: join(dataDir, "context.sqlite") });
    const service = new SqliteContextEngineService({
      database,
      rootDirectory: dataDir,
      now: () => "2026-07-21T10:00:00.000Z",
    });
    const startWorkstreamResolution = vi.spyOn(service, "startWorkstreamResolution");
    const runtime = createContextEngineRuntime({
      service,
      timezone: "Asia/Kolkata",
      agentId: "local",
      scopeKey: "default",
    });
    const prepareUserTurn = vi.spyOn(runtime, "prepareUserTurn");
    const recordRunStep = vi.spyOn(runtime, "recordRunStep");
    const finalizeRun = vi.spyOn(runtime, "finalizeRun");
    const provider = createProvider([
      {
        kind: "resolve_workstream",
        request: {
          purpose: "Resolve the durable owner for one-run.txt.",
          hints: [{ kind: "filesystem", path: workingDirectory }],
        },
      },
      {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "resolver-search",
            tool: "resolution_search_workstreams",
            input: { query: "one-run.txt" },
            dependsOn: [],
            purpose: "Search authoritative workstream state",
          }],
          allowedTools: ["resolution_search_workstreams"],
          assertions: [],
        },
      },
      {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "resolver-create",
            tool: "resolution_create_workstream",
            input: {
              title: "One run file",
              objective: "Create and verify one-run.txt.",
              initialRequest: {
                title: "Create one-run.txt",
                request: "Create the requested one-run.txt file.",
                acceptance: ["one-run.txt exists with the requested content."],
                constraints: [],
              },
              resources: [],
              evidence: ["Authoritative catalog search found no owning workstream."],
            },
            dependsOn: [],
            purpose: "Create the single owning workstream",
          }],
          allowedTools: ["resolution_create_workstream"],
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
          kind: "workstream_completion",
          request: {
            summary: "Created and verified one-run.txt.",
            resources: [],
          },
      },
      { kind: "reply", status: "completed", message: "Created one-run.txt." },
    ]);
    const onReply = vi.fn();
    const engine = createEngine({
      onReply,
      provider,
      dataDir,
      chatContextRuntime: runtime,
      contextEngineService: service,
      toolExecutor: createToolExecutor([writeFilesTool]),
    });

    try {
      await engine.start();
      engine.handleMessage("c1", { type: "chat", content: "Create one-run.txt" });

      await vi.waitFor(() => {
        expect(onReply.mock.calls.some(([, response]) => (
          response as { type?: string }
        ).type === "reply")).toBe(true);
      }, { timeout: 5_000 });
      expect(readFileSync(outputPath, "utf8")).toBe("same durable run");
      expect(recordRunStep).toHaveBeenCalledOnce();
      const prepared = await prepareUserTurn.mock.results[0]!.value;
      expect(recordRunStep).toHaveBeenCalledWith(expect.objectContaining({
        turn: expect.objectContaining({ run: expect.objectContaining({ runId: prepared.run.runId }) }),
        record: expect.objectContaining({
          runId: prepared.run.runId,
          step: 1,
          toolCalls: [expect.objectContaining({ tool: "write_files" })],
        }),
      }));
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
        turn: expect.objectContaining({ run: expect.objectContaining({ runId: prepared.run.runId }) }),
        outcome: "done",
        stopReason: "completed",
        workstreamCompletion: expect.objectContaining({ accepted: true }),
      }));
      expect(onReply).toHaveBeenCalledWith("c1", expect.objectContaining({
        type: "reply",
        content: "Created one-run.txt.",
        runId: prepared.run.runId,
      }));
      const startedResolution = await startWorkstreamResolution.mock.results[0]!.value;
      const resolution = await service.getWorkstreamResolution({
        activityId: startedResolution.activity.activityId,
      });
      expect(resolution.activity).toMatchObject({
        runId: prepared.run.runId,
        status: "resolved",
        stepCount: 2,
      });
      expect(resolution.steps).toHaveLength(2);
      expect(resolution.steps.flatMap((step) => step.toolCalls)).toHaveLength(2);
      const terminalReplyIndex = onReply.mock.calls.findIndex(([, response]) => (
        response as { type?: string }
      ).type === "reply");
      expect(finalizeRun.mock.invocationCallOrder[0])
        .toBeLessThan(onReply.mock.invocationCallOrder[terminalReplyIndex]!);
    } finally {
      await engine.stop();
      await service.close();
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
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("workstreamCompletion");
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
      expect(vi.mocked(runtime.finalizeRun).mock.calls[0]?.[0]).not.toHaveProperty("workstreamCompletion");
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
