import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmMessage } from "../../src/core/contracts/llm-protocol.js";
import { createChatTurnRuntime } from "../../src/app/chat-turn-runtime.js";
import { createGitMemoryChatContextRuntime } from "../../src/app/git-memory-chat-context-runtime.js";
import type { AgentFeedbackEventInput } from "../../src/ivec/feedback-ledger.js";
import type { AgentLoopResult } from "../../src/ivec/types.js";
import {
  createGitMemoryRuntime,
  GitMemoryDailySessionStore,
  type GitMemoryWriteBatchSnapshot,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionStoreAttachmentsPath,
  gitMemorySessionStoreRunPath,
  gitMemorySessionStoreStepsPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStepsPath,
} from "../../src/context-engine/index.js";
import { FileLibrary } from "../../src/files/file-library.js";
import { readFileTool } from "../../src/skills/builtins/filesystem/read-file.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

describe("createChatTurnRuntime", () => {
  it("streams final replies only for clients that support reply streaming", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-stream-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const replies: Array<{ clientId: string; data: Record<string, unknown> }> = [];
      const runtime = createChatTurnRuntime({
        dataDir,
        chatContextRuntime: createGitMemoryChatContextRuntime({ gitMemoryRuntime }),
        clientSupportsReplyStreaming: (clientId) => clientId === "streaming-client",
        onReply: (clientId, data) => {
          replies.push({ clientId, data: data as Record<string, unknown> });
        },
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "streaming-client",
        content: "hello streaming",
        attachments: [],
      });

      const streamingEvents = replies.filter((reply) => reply.clientId === "streaming-client").map((reply) => reply.data);
      expect(streamingEvents[0]).toMatchObject({
        type: "reply_started",
        kind: "reply",
      });
      const turnId = streamingEvents[0]?.["turnId"];
      expect(typeof turnId).toBe("string");
      const deltas = streamingEvents.filter((event) => event["type"] === "reply_delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.map((event) => event["delta"]).join("")).toBe('Received: "hello streaming"');
      expect(streamingEvents.at(-1)).toMatchObject({
        type: "reply_done",
        turnId,
        kind: "reply",
        content: 'Received: "hello streaming"',
        commitStatus: "skipped",
      });
      expect(streamingEvents.some((event) => event["type"] === "reply")).toBe(false);

      await runtime.processChat({
        clientId: "legacy-client",
        content: "hello legacy",
        attachments: [],
      });

      const legacyEvents = replies.filter((reply) => reply.clientId === "legacy-client").map((reply) => reply.data);
      expect(legacyEvents).toEqual([{
        type: "reply",
        content: 'Received: "hello legacy"',
      }]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes chat turns for the same client before preparing pending turns", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const originalPrepareUserTurn = chatContextRuntime.prepareUserTurn.bind(chatContextRuntime);
      const preparedMessages: string[] = [];
      vi.spyOn(chatContextRuntime, "prepareUserTurn").mockImplementation(async (input) => {
        preparedMessages.push(input.userMessage);
        return await originalPrepareUserTurn(input);
      });

      const { provider, generateTurn, releaseFirst } = createGatedReplyProvider();
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      const first = runtime.processChat({
        clientId: "local",
        content: "hello first",
        attachments: [],
      });
      await waitUntil(() => generateTurn.mock.calls.length === 1);

      const second = runtime.processChat({
        clientId: "local",
        content: "hello second",
        attachments: [],
      });
      await delay(50);

      expect(preparedMessages).toEqual(["hello first"]);
      expect(generateTurn).toHaveBeenCalledTimes(1);

      releaseFirst();
      await Promise.all([first, second]);
      await waitForCommittedWrites(gitMemoryRuntime, "S-20260628-local", 4);

      expect(preparedMessages).toEqual(["hello first", "hello second"]);
      expect(generateTurn).toHaveBeenCalledTimes(2);

      const records = await store.readSessionConversationRecords("S-20260628-local");
      expect(records.filter((record) => record.role === "user").map((record) => record.text)).toEqual([
        "hello first",
        "hello second",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not finalize a stale pending task run from a direct interaction reply", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const first = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:00+05:30",
      });
      const routed = await chatContextRuntime.routeTaskTurn({
        clientId: "local",
        turn: first,
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:01+05:30",
      });
      if (routed?.status !== "ready") {
        throw new Error(`Expected ready route, got ${routed?.status}.`);
      }

      const { provider } = createReplyProvider("We are working on the focus timer website task.");
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "what task are we working on?",
        attachments: [],
      });

      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", first.sessionId));
      expect(await driver.readFile(
        routed.ref,
        gitMemoryTaskRunPath(routed.taskId, routed.runId),
      )).toBeNull();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("records no-binding direct replies as conversation or enquiry instead of task finalization failures", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const feedbackEvents: AgentFeedbackEventInput[] = [];
      const { provider } = createReplyProvider("Ayati is a persistent AI agent daemon.");
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime: createGitMemoryChatContextRuntime({ gitMemoryRuntime }),
        feedbackLedger: createFeedbackRecorder(feedbackEvents),
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "what is Ayati?",
        attachments: [],
      });

      expect(feedbackEvents).toContainEqual(expect.objectContaining({
        stage: "context_engine",
        event: "conversation_enquiry_recorded",
        data: expect.objectContaining({
          reason: "conversation_or_enquiry_without_task_run",
          skipReason: "no_task_run_binding",
        }),
      }));
      expect(feedbackEvents).not.toContainEqual(expect.objectContaining({
        stage: "context_engine",
        event: "finalization_failed",
      }));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps task-like no-binding completions visible as finalization failures", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const turn = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a one page website",
        at: "2026-06-28T09:00:00+05:30",
      });
      const feedbackEvents: AgentFeedbackEventInput[] = [];
      const { provider } = createReplyProvider("unused");
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        feedbackLedger: createFeedbackRecorder(feedbackEvents),
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const result: AgentLoopResult = {
        type: "reply",
        runClass: "interaction",
        content: "Done. I created the website files.",
        status: "completed",
        totalIterations: 1,
        totalToolCalls: 0,
        runPath: "",
        completedSteps: [],
        workState: {
          status: "done",
          summary: "Done. I created the website files.",
          openWork: [],
          blockers: [],
          verifiedFacts: [],
          evidence: [],
        },
      };

      await (runtime as any).completeChatContextRun("local", turn, null, result);

      expect(feedbackEvents).toContainEqual(expect.objectContaining({
        stage: "context_engine",
        event: "finalization_failed",
        data: expect.objectContaining({
          reason: "taskful_result_without_task_run_binding",
          skipReason: "no_task_run_binding",
        }),
      }));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("commits a routed task run as failed when the provider throws", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const first = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:00+05:30",
      });
      await gitMemoryRuntime.createTaskBranch({
        sessionId: first.sessionId,
        title: "Focus Timer Website",
        objective: "Create a tiny focus timer website.",
        fromSeq: first.messageSeq,
        toSeq: first.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });

      const replies: unknown[] = [];
      const { provider } = createThrowingProvider(new Error("Unexpected end of JSON input"));
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        onReply: (_clientId, data) => {
          replies.push(data);
        },
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "continue",
        attachments: [],
      });

      expect(replies).toContainEqual(expect.objectContaining({
        type: "error",
        content: "Failed to generate a response.",
      }));

      const context = await chatContextRuntime.buildActiveContext(first.sessionId);
      expect(context.task?.recentRuns[0]).toMatchObject({
        status: "failed",
        summary: "Task run failed before completion.",
        toolCallCount: 0,
      });

      const failedRun = context.task?.recentRuns[0];
      if (!context.task || !failedRun) {
        throw new Error("Expected failed run context.");
      }
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", first.sessionId));
      expect(JSON.parse(await driver.readFile(
        `refs/heads/${context.task.branch}`,
        gitMemoryTaskRunPath(context.task.taskId, failedRun.runId),
      ) ?? "{}")).toMatchObject({
        status: "failed",
        blockers: ["Unexpected end of JSON input"],
        next: "Retry or continue the task.",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("commits an agent-routed task run as failed when only the bound pending turn is available", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const first = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:00+05:30",
      });
      const task = await gitMemoryRuntime.createTaskBranch({
        sessionId: first.sessionId,
        title: "Focus Timer Website",
        objective: "Create a tiny focus timer website.",
        fromSeq: first.messageSeq,
        toSeq: first.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });
      const followUp = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "add a dark mode toggle to it",
        at: "2026-06-28T09:05:00+05:30",
      });
      const routed = await chatContextRuntime.activateTaskTurn({
        clientId: "local",
        turn: followUp,
        taskId: task.taskId,
        reason: "The user is continuing the focus timer website task.",
        at: "2026-06-28T09:05:01+05:30",
      });
      if (routed?.status !== "ready") {
        throw new Error(`Expected ready route, got ${routed?.status}.`);
      }

      const { provider } = createReplyProvider("unused");
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        now: () => new Date("2026-06-28T09:06:00.000Z"),
      });

      await (runtime as any).completeFailedChatContextRun(
        "local",
        followUp,
        null,
        {
          sessionId: followUp.sessionId,
          runId: routed.runId,
          triggerSeq: followUp.messageSeq,
        },
        new Error("Expected JSON object but received malformed provider output"),
      );

      const context = await chatContextRuntime.buildActiveContext(first.sessionId);
      expect(context.task?.recentRuns[0]).toMatchObject({
        runId: routed.runId,
        status: "failed",
        summary: "Task run failed before completion.",
        toolCallCount: 0,
      });
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", first.sessionId));
      expect(JSON.parse(await driver.readFile(
        routed.ref,
        gitMemoryTaskRunPath(task.taskId, routed.runId),
      ) ?? "{}")).toMatchObject({
        status: "failed",
        blockers: ["Expected JSON object but received malformed provider output"],
        next: "Retry or continue the task.",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks a routed task run when a direct reply produces no durable evidence", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const first = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:00+05:30",
      });
      await gitMemoryRuntime.createTaskBranch({
        sessionId: first.sessionId,
        title: "Focus Timer Website",
        objective: "Create a tiny focus timer website.",
        fromSeq: first.messageSeq,
        toSeq: first.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });

      const { provider } = createReplyProvider("I will continue the focus timer website task.");
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "continue",
        attachments: [],
      });

      const context = await chatContextRuntime.buildActiveContext(first.sessionId);
      expect(context.task?.status).toBe("blocked");
      expect(context.task?.recentRuns[0]).toMatchObject({
        status: "blocked",
        summary: "Task run stopped without durable work evidence.",
        toolCallCount: 0,
      });

      const blockedRun = context.task?.recentRuns[0];
      if (!context.task || !blockedRun) {
        throw new Error("Expected blocked run context.");
      }
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", first.sessionId));
      expect(JSON.parse(await driver.readFile(
        `refs/heads/${context.task.branch}`,
        gitMemoryTaskRunPath(context.task.taskId, blockedRun.runId),
      ) ?? "{}")).toMatchObject({
        status: "blocked",
        blockers: ["The run completed without tool calls or durable evidence."],
        next: "Retry or continue the task with concrete work.",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("blocks a routed task run when only read-only tools succeed", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-read-only-task-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const workspaceDir = join(rootDir, "workspace");
    const previousWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "focus.ts"), "export const focusTimer = true;\n", "utf-8");
    process.env["AYATI_WORKSPACE_DIR"] = workspaceDir;

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const first = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "create a tiny focus timer website",
        at: "2026-06-28T09:00:00+05:30",
      });
      await gitMemoryRuntime.createTaskBranch({
        sessionId: first.sessionId,
        title: "Focus Timer Website",
        objective: "Create a tiny focus timer website.",
        fromSeq: first.messageSeq,
        toSeq: first.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });
      const provider = createAgentDecisionProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read_focus",
              tool: "read_file",
              input: { path: "focus.ts", mode: "search", query: "focusTimer" },
              dependsOn: [],
              purpose: "Inspect the current focus timer file.",
            }],
            allowedTools: ["read_file"],
            assertions: [],
          },
        },
        {
          kind: "update_work_state",
          update: {
            status: "done",
            summary: "Inspected the focus timer file.",
            openWork: [],
            blockers: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "I inspected the focus timer file.",
        },
      ]);
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        toolExecutor: createToolExecutor([readFileTool]),
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "continue",
        attachments: [],
      });

      const context = await chatContextRuntime.buildActiveContext(first.sessionId);
      expect(context.task?.status).toBe("blocked");
      expect(context.task?.recentRuns[0]).toMatchObject({
        status: "blocked",
        summary: "Task run stopped without durable work evidence.",
        toolCallCount: 1,
      });

      const blockedRun = context.task?.recentRuns[0];
      if (!context.task || !blockedRun) {
        throw new Error("Expected blocked read-only task run context.");
      }
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", first.sessionId));
      const run = JSON.parse(await driver.readFile(
        `refs/heads/${context.task.branch}`,
        gitMemoryTaskRunPath(context.task.taskId, blockedRun.runId),
      ) ?? "{}");
      expect(run).toMatchObject({
        status: "blocked",
        blockers: ["The run completed without tool calls or durable evidence."],
        next: "Retry or continue the task with concrete work.",
        toolCallCount: 1,
      });
      const steps = readJsonl(await driver.readFile(
        `refs/heads/${context.task.branch}`,
        gitMemoryTaskStepsPath(context.task.taskId, blockedRun.runId),
      ));
      expect(steps.map((step) => step.toolCalls?.[0]?.tool)).toEqual(["read_file"]);
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env["AYATI_WORKSPACE_DIR"];
      } else {
        process.env["AYATI_WORKSPACE_DIR"] = previousWorkspaceDir;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("records session-only attachments in the session-store before the agent decision", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const attachmentPath = join(rootDir, "policy.txt");
    writeFileSync(attachmentPath, "Policy text for the session attachment.", "utf-8");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const { provider, generateTurn } = createReplyProvider();
      const replies: unknown[] = [];
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        fileLibrary: new FileLibrary({
          dataDir,
          now: () => new Date("2026-06-28T09:00:00.000Z"),
        }),
        chatContextRuntime: createGitMemoryChatContextRuntime({ gitMemoryRuntime }),
        onReply: (_clientId, data) => {
          replies.push(data);
        },
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "remember this file for later",
        attachments: [{
          source: "cli",
          type: "file",
          path: attachmentPath,
          name: "policy.txt",
        }],
      });

      const sessionId = "S-20260628-local";
      const attachmentsFile = await store.readSessionAttachments(sessionId);
      expect(attachmentsFile?.attachments).toHaveLength(1);
      expect(attachmentsFile?.attachments[0]).toMatchObject({
        kind: "file",
        name: "policy.txt",
        source: "local_path",
        status: "ready",
        originalPath: attachmentPath,
      });

      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      expect(JSON.parse(await sessionStore.readWorkingFile(
        gitMemorySessionStoreAttachmentsPath(sessionId),
      ) ?? "{}")).toMatchObject({
        schemaVersion: 1,
        sessionId,
        attachments: [{
          name: "policy.txt",
          originalPath: attachmentPath,
        }],
      });

      const stateView = extractStateView(generateTurn.mock.calls[0]?.[0]?.messages ?? []);
      expect(stateView.context.git.session.attachments).toMatchObject({
        count: 1,
        recent: [{
          name: "policy.txt",
          kind: "file",
          status: "ready",
          originalPath: attachmentPath,
        }],
      });
      expect(stateView.context.run).not.toHaveProperty("attachments");
      expect(replies).toContainEqual(expect.objectContaining({
        type: "reply",
        content: "Noted.",
      }));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("finalizes read-only chat tool work as a session-store run without creating a task", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-session-read-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const workspaceDir = join(rootDir, "workspace");
    const previousWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "upload.ts"), "export function handleUpload() { return true; }\n", "utf-8");
    process.env["AYATI_WORKSPACE_DIR"] = workspaceDir;

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const provider = createAgentDecisionProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read_upload",
              tool: "read_file",
              input: { path: "upload.ts", mode: "search", query: "handleUpload" },
              dependsOn: [],
              purpose: "Inspect upload handling without mutating workspace state.",
            }],
            allowedTools: ["read_file"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Upload handling lives in upload.ts.",
        },
      ]);
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime: createGitMemoryChatContextRuntime({ gitMemoryRuntime }),
        toolExecutor: createToolExecutor([readFileTool]),
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "where is upload handling implemented?",
        attachments: [],
      });

      const sessionId = "S-20260628-local";
      const runId = "R-20260628-0001";
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      const sessionRun = JSON.parse(await sessionStore.readWorkingFile(
        gitMemorySessionStoreRunPath(sessionId, runId),
      ) ?? "{}");
      expect(sessionRun).toMatchObject({
        sessionId,
        runId,
        runClass: "session",
        status: "completed",
        summary: "Upload handling lives in upload.ts.",
        intent: "Upload handling lives in upload.ts.",
        outcome: "Upload handling lives in upload.ts.",
        workPerformed: expect.any(Array),
        toolCallCount: 1,
        toolsUsed: ["read_file"],
        changedFiles: [],
        newFacts: expect.any(Array),
        workState: {
          status: expect.any(String),
          verifiedFacts: expect.any(Array),
          evidence: expect.any(Array),
        },
      });
      expect(sessionRun.workPerformed.length).toBeGreaterThan(0);
      expect(await sessionStore.readFile(
        GIT_MEMORY_MAIN_REF,
        gitMemorySessionStoreRunPath(sessionId, runId),
      )).toBeNull();
      const steps = readJsonl(await sessionStore.readWorkingFile(
        gitMemorySessionStoreStepsPath(sessionId, runId),
      ));
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        sessionId,
        runId,
        toolCalls: [{ tool: "read_file", status: "success" }],
        workStateAfter: expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.stringContaining("read_file"),
          ]),
        }),
      });
      expect(await driver.listTreePaths(GIT_MEMORY_MAIN_REF, "tasks")).toEqual([]);
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env["AYATI_WORKSPACE_DIR"];
      } else {
        process.env["AYATI_WORKSPACE_DIR"] = previousWorkspaceDir;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps vague durable-work discussion as messages only when no tools run", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-target-only-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const provider = createAgentDecisionProvider([
        {
          kind: "reply",
          status: "completed",
          message: "I can create the notes file when you want me to proceed.",
        },
      ]);
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime: createGitMemoryChatContextRuntime({ gitMemoryRuntime }),
        toolExecutor: createToolExecutor([]),
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "maybe create a notes file",
        attachments: [],
      });

      const sessionId = "S-20260628-local";
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      expect(await sessionStore.listTreePaths(GIT_MEMORY_MAIN_REF, `sessions/${sessionId}/runs`)).toEqual([]);
      expect(await sessionStore.listTreePaths(GIT_MEMORY_MAIN_REF, `sessions/${sessionId}/steps`)).toEqual([]);
      expect(await driver.listTreePaths(GIT_MEMORY_MAIN_REF, "tasks")).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("creates a new task after mutation is blocked in a fresh session", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-target-promote-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const workspaceDir = join(rootDir, "workspace");
    const previousWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];
    mkdirSync(workspaceDir, { recursive: true });
    process.env["AYATI_WORKSPACE_DIR"] = workspaceDir;

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const gitContextSkill = createGitContextSkill({ contextStoreDir, gitMemoryRuntime });
      const provider = createAgentDecisionProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_before_task",
              tool: "write_files",
              input: {
                files: [{ path: "notes.md", content: "# Notes\n\nShould wait for task routing.\n" }],
              },
              dependsOn: [],
              purpose: "Try to create the requested notes file before task ownership is resolved.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "create_notes_task",
              tool: "git_context_create_task_for_turn",
              input: {
                title: "Create notes",
                objective: "Create a notes file.",
                createReason: "no_active_task",
              },
              dependsOn: [],
              purpose: "Create and activate the task required before mutation.",
            }],
            allowedTools: ["git_context_create_task_for_turn"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_notes",
              tool: "write_files",
              input: {
                files: [{ path: "notes.md", content: "# Notes\n\nCreated after promotion.\n" }],
              },
              dependsOn: [],
              purpose: "Create the requested notes file.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
            completion: {
              intent: "completion_candidate",
              reason: "The file write completes the requested upload note update.",
            },
          },
        },
        {
          kind: "update_work_state",
          update: {
            status: "done",
            summary: "Created the notes file.",
            openWork: [],
            blockers: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Created `notes.md`.",
        },
      ]);
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        toolExecutor: createToolExecutor([...gitContextSkill.tools, writeFilesTool]),
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "create a notes file",
        attachments: [],
      });

      const sessionId = "S-20260628-local";
      const runId = "R-20260628-0001";
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      expect(await sessionStore.readFile(
        GIT_MEMORY_MAIN_REF,
        gitMemorySessionStoreRunPath(sessionId, runId),
      )).toBeNull();

      const context = await chatContextRuntime.buildActiveContext(sessionId);
      expect(context.task).toMatchObject({
        title: "Create notes",
        objective: "Create a notes file.",
      });
      expect(context.task?.recentRuns[0]).toMatchObject({
        runId,
        status: "completed",
        toolCallCount: 1,
      });
      expect(readFileSync(join(workspaceDir, "notes.md"), "utf-8")).toContain("Created after promotion.");
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env["AYATI_WORKSPACE_DIR"];
      } else {
        process.env["AYATI_WORKSPACE_DIR"] = previousWorkspaceDir;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps clarification turns session-only and promotes the answer turn when it mutates", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-clarify-promote-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const workspaceDir = join(rootDir, "workspace");
    const previousWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];
    mkdirSync(workspaceDir, { recursive: true });
    process.env["AYATI_WORKSPACE_DIR"] = workspaceDir;

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const apiTurn = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "fix upload API",
        at: "2026-06-28T09:00:00+05:30",
      });
      const apiTask = await gitMemoryRuntime.createTaskBranch({
        sessionId: apiTurn.sessionId,
        title: "Fix upload API",
        objective: "Fix upload API behavior.",
        fromSeq: apiTurn.messageSeq,
        toSeq: apiTurn.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });
      const uiTurn = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "fix upload UI",
        at: "2026-06-28T09:01:00+05:30",
      });
      const uiTask = await gitMemoryRuntime.createTaskBranch({
        sessionId: uiTurn.sessionId,
        title: "Fix upload UI",
        objective: "Fix upload UI behavior.",
        fromSeq: uiTurn.messageSeq,
        toSeq: uiTurn.messageSeq,
        at: "2026-06-28T09:01:01+05:30",
      });
      const gitContextSkill = createGitContextSkill({ contextStoreDir, gitMemoryRuntime });
      const provider = createAgentDecisionProvider([
        {
          kind: "reply",
          status: "completed",
          message: "Which upload task do you mean: API or UI?",
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "activate_api",
              tool: "git_context_activate_task_for_turn",
              input: {
                taskId: apiTask.taskId,
                reason: "user_selected_task",
              },
              dependsOn: [],
              purpose: "Bind this fresh clarification answer turn to the API upload task.",
            }],
            allowedTools: ["git_context_activate_task_for_turn"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_api_note",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{
                  path: "notes/upload-api.md",
                  content: "# Upload API\n\nClarified follow-up belongs to the API task.\n",
                }],
              },
              dependsOn: [],
              purpose: "Persist the clarified API upload note.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
            completion: {
              intent: "not_completion",
              reason: "The task state still needs to be updated after the file write.",
            },
          },
        },
        {
          kind: "update_work_state",
          update: {
            status: "done",
            summary: "Updated the upload API note after clarification.",
            openWork: [],
            blockers: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Updated the upload API note.",
        },
      ]);
      const replies: unknown[] = [];
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        toolExecutor: createToolExecutor([...gitContextSkill.tools, writeFilesTool]),
        onReply: (_clientId, data) => {
          replies.push(data);
        },
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "continue upload",
        attachments: [],
      });
      await runtime.processChat({
        clientId: "local",
        content: "the API one",
        attachments: [],
      });

      const sessionId = apiTurn.sessionId;
      const answerRunId = "R-20260628-0001";
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      expect(await sessionStore.listTreePaths(GIT_MEMORY_MAIN_REF, `sessions/${sessionId}/runs`)).toEqual([]);
      expect(await sessionStore.listTreePaths(GIT_MEMORY_MAIN_REF, `sessions/${sessionId}/steps`)).toEqual([]);
      expect(await sessionStore.readFile(
        GIT_MEMORY_MAIN_REF,
        gitMemorySessionStoreRunPath(sessionId, answerRunId),
      )).toBeNull();
      expect(await driver.readFile(
        uiTask.ref,
        gitMemoryTaskRunPath(uiTask.taskId, answerRunId),
      )).toBeNull();

      const apiRun = JSON.parse(await driver.readFile(
        apiTask.ref,
        gitMemoryTaskRunPath(apiTask.taskId, answerRunId),
      ) ?? "{}");
      expect(apiRun).toMatchObject({
        taskId: apiTask.taskId,
        runId: answerRunId,
        status: "completed",
        summary: "Updated the upload API note.",
        toolCallCount: 1,
      });
      expect(readJsonl(await driver.readFile(
        apiTask.ref,
        gitMemoryTaskStepsPath(apiTask.taskId, answerRunId),
      )).map((step) => step.toolCalls?.[0]?.tool)).toEqual([
        "write_files",
      ]);
      expect(readFileSync(join(workspaceDir, "notes/upload-api.md"), "utf-8"))
        .toContain("Clarified follow-up belongs to the API task.");
      expect(replies).toContainEqual(expect.objectContaining({
        type: "reply",
        content: "Which upload task do you mean: API or UI?",
      }));
      expect(replies).toContainEqual(expect.objectContaining({
        type: "reply",
        content: "Updated the upload API note.",
      }));
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env["AYATI_WORKSPACE_DIR"];
      } else {
        process.env["AYATI_WORKSPACE_DIR"] = previousWorkspaceDir;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("promotes an active session run into the task run when mutation becomes necessary", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ayati-chat-runtime-session-promote-"));
    const contextStoreDir = join(rootDir, "context");
    const dataDir = join(rootDir, "data");
    const workspaceDir = join(rootDir, "workspace");
    const previousWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "upload.ts"), "export function handleUpload() { return true; }\n", "utf-8");
    process.env["AYATI_WORKSPACE_DIR"] = workspaceDir;

    try {
      const store = new GitMemoryDailySessionStore({
        contextStoreDir,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
        store,
        now: () => new Date("2026-06-28T09:00:00.000Z"),
      });
      const chatContextRuntime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const initial = await chatContextRuntime.prepareUserTurn({
        clientId: "local",
        userMessage: "fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });
      const task = await gitMemoryRuntime.createTaskBranch({
        sessionId: initial.sessionId,
        title: "Fix upload handling",
        objective: "Find and fix upload handling issues.",
        fromSeq: initial.messageSeq,
        toSeq: initial.messageSeq,
        at: "2026-06-28T09:00:01+05:30",
      });
      const gitContextSkill = createGitContextSkill({ contextStoreDir, gitMemoryRuntime });
      const provider = createAgentDecisionProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read_upload",
              tool: "read_file",
              input: { path: "upload.ts", mode: "search", query: "handleUpload" },
              dependsOn: [],
              purpose: "Inspect upload handling before editing task notes.",
            }],
            allowedTools: ["read_file"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_upload_notes",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{
                  path: "notes/upload.md",
                  content: "# Upload notes\n\nhandleUpload is currently implemented in upload.ts.\n",
                }],
              },
              dependsOn: [],
              purpose: "Persist the upload handling note.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
            completion: {
              intent: "not_completion",
              reason: "The task work state still needs to be updated after the file write.",
            },
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "activate_upload_task",
              tool: "git_context_activate_task_for_turn",
              input: {
                taskId: task.taskId,
                reason: "continue_active_task",
              },
              dependsOn: [],
              purpose: "Bind the deferred upload note mutation to the active upload task.",
            }],
            allowedTools: ["git_context_activate_task_for_turn"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Updated the upload handling notes.",
        },
      ]);
      const runtime = createChatTurnRuntime({
        provider,
        dataDir,
        chatContextRuntime,
        toolExecutor: createToolExecutor([...gitContextSkill.tools, readFileTool, writeFilesTool]),
        now: () => new Date("2026-06-28T09:05:00.000Z"),
      });

      await runtime.processChat({
        clientId: "local",
        content: "inspect upload.ts and update the upload notes",
        attachments: [],
      });

      const sessionId = initial.sessionId;
      const runId = "R-20260628-0001";
      const driver = new GitMemoryWorktreeGitDriver(join(contextStoreDir, "sessions", sessionId));
      const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
      expect(await sessionStore.readFile(
        GIT_MEMORY_MAIN_REF,
        gitMemorySessionStoreRunPath(sessionId, runId),
      )).toBeNull();
      expect(await sessionStore.readFile(
        GIT_MEMORY_MAIN_REF,
        gitMemorySessionStoreStepsPath(sessionId, runId),
      )).toBeNull();

      const context = await chatContextRuntime.buildActiveContext(sessionId);
      const completedRun = context.task?.recentRuns[0];
      expect(completedRun).toMatchObject({
        runId,
        status: "completed",
        summary: "Updated the upload handling notes.",
        toolCallCount: 2,
      });
      expect(JSON.parse(await driver.readFile(
        task.ref,
        gitMemoryTaskRunPath(task.taskId, runId),
      ) ?? "{}")).toMatchObject({
        taskId: task.taskId,
        runId,
        status: "completed",
        toolCallCount: 2,
      });
      const taskSteps = readJsonl(await driver.readFile(
        task.ref,
        gitMemoryTaskStepsPath(task.taskId, runId),
      ));
      expect(taskSteps).toHaveLength(2);
      expect(taskSteps.map((step) => step.toolCalls?.[0]?.tool)).toEqual(["read_file", "write_files"]);
      expect(readFileSync(join(workspaceDir, "notes/upload.md"), "utf-8")).toContain("handleUpload");
    } finally {
      if (previousWorkspaceDir === undefined) {
        delete process.env["AYATI_WORKSPACE_DIR"];
      } else {
        process.env["AYATI_WORKSPACE_DIR"] = previousWorkspaceDir;
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

function createReplyProvider(content = "Noted."): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
} {
  const generateTurn = vi.fn(async () => ({
    type: "assistant" as const,
    content,
  }));
  return {
    provider: {
      name: "fake-provider",
      version: "test",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createGatedReplyProvider(): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
  releaseFirst: () => void;
} {
  let callCount = 0;
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const generateTurn = vi.fn(async () => {
    callCount += 1;
    const current = callCount;
    if (current === 1) {
      await firstGate;
    }
    return {
      type: "assistant" as const,
      content: `reply ${current}`,
    };
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
    releaseFirst,
  };
}

function createThrowingProvider(error: unknown): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
} {
  const generateTurn = vi.fn(async () => {
    throw error;
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: true,
        },
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createAgentDecisionProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map((response) => typeof response === "string" ? response : JSON.stringify(response));
  return {
    name: "fake-provider",
    version: "test",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: true,
        jsonSchema: true,
      },
    },
    start() {},
    stop() {},
    generateTurn: vi.fn(async () => {
      const content = queue.shift();
      if (!content) {
        throw new Error("No queued provider response.");
      }
      return {
        type: "assistant" as const,
        content,
      };
    }),
  };
}

function createFeedbackRecorder(events: AgentFeedbackEventInput[]) {
  return {
    enabled: true,
    record(event: AgentFeedbackEventInput): void {
      events.push(event);
    },
    async flush(): Promise<void> {
      return;
    },
    async close(): Promise<void> {
      return;
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(10);
  }
}

async function waitForCommittedWrites(
  runtime: { getSessionWrites(sessionId: string): GitMemoryWriteBatchSnapshot[] },
  sessionId: string,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const writes = runtime.getSessionWrites(sessionId);
    if (writes.length >= count && writes.slice(0, count).every((write) => write.status === "committed")) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for git memory writes: ${JSON.stringify(runtime.getSessionWrites(sessionId))}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStateView(messages: LlmMessage[]): any {
  const user = [...messages].reverse().find((message) => message.role === "user");
  const content = typeof user?.content === "string" ? user.content : "";
  const marker = "State view:\n";
  const start = content.indexOf(marker);
  if (start < 0) {
    throw new Error("State view section missing from decision prompt.");
  }
  return JSON.parse(content.slice(start + marker.length).trim());
}

function readJsonl(value: string | null): any[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split("\n").map((line) => JSON.parse(line));
}
