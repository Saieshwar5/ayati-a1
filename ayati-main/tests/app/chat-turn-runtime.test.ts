import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionStoreAttachmentsPath,
  gitMemoryTaskRunPath,
} from "../../src/context-engine/index.js";
import { FileLibrary } from "../../src/files/file-library.js";

describe("createChatTurnRuntime", () => {
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
