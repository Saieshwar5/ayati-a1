import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmMessage } from "../../src/core/contracts/llm-protocol.js";
import { createChatTurnRuntime } from "../../src/app/chat-turn-runtime.js";
import { createGitMemoryChatContextRuntime } from "../../src/app/git-memory-chat-context-runtime.js";
import {
  createGitMemoryRuntime,
  GitMemoryDailySessionStore,
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionStoreAttachmentsPath,
  gitMemoryTaskRunPath,
} from "../../src/context-engine/index.js";
import { FileLibrary } from "../../src/files/file-library.js";

describe("createChatTurnRuntime", () => {
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
      expect(stateView.context.scratch.attachments).toMatchObject({
        managedFiles: [{ name: "policy.txt", status: "new" }],
      });
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
