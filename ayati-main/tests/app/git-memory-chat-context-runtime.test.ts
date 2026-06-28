import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitMemoryChatContextRuntime } from "../../src/app/git-memory-chat-context-runtime.js";
import {
  createGitMemoryRuntime,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GitMemoryWorktreeGitDriver,
} from "../../src/context-engine/index.js";

describe("createGitMemoryChatContextRuntime", () => {
  it("prepares user turns from the git-memory runtime without allocating task ids", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const runtime = createGitMemoryChatContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });

      const prepared = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });

      expect(prepared).toMatchObject({
        status: "ready",
        sessionId: "S-20260628-local",
        initialized: true,
        messageSeq: 1,
        messageId: "M-20260628-000001",
        turnId: "T-20260628-000001",
        context: {
          session: {
            conversationTail: [{
              seq: 1,
              role: "user",
              text: "Fix upload handling",
            }],
          },
          focus: { status: "none" },
        },
      });
      expect(prepared.context.task).toBeUndefined();
      expect(await new GitMemoryWorktreeGitDriver(prepared.repoPath).log(GIT_MEMORY_MAIN_REF, 5))
        .toHaveLength(1);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("records assistant replies against the prepared turn in canonical conversation", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const runtime = createGitMemoryChatContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });
      const prepared = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });

      const assistant = await runtime.recordAssistantMessage({
        clientId: "local",
        turn: prepared,
        message: "I will inspect upload handling.",
        at: "2026-06-28T09:00:05+05:30",
      });

      expect(assistant).toMatchObject({
        seq: 2,
        role: "assistant",
        turnId: prepared.turnId,
        text: "I will inspect upload handling.",
      });
      const context = await runtime.buildActiveContext(prepared.sessionId);
      expect(context.session.conversationTail).toMatchObject([
        { seq: 1, role: "user", text: "Fix upload handling" },
        { seq: 2, role: "assistant", text: "I will inspect upload handling.", turnId: prepared.turnId },
      ]);

      const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
      expect(parseJsonl(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH)))
        .toHaveLength(2);
      expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("attaches task and run ids to assistant replies when the caller has them", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const runtime = createGitMemoryChatContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });
      const prepared = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });

      const assistant = await runtime.recordAssistantMessage({
        clientId: "local",
        turn: prepared,
        message: "Finished upload handling inspection.",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
        at: "2026-06-28T09:10:00+05:30",
      });

      expect(assistant).toMatchObject({
        seq: 2,
        role: "assistant",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
      });
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("ignores assistant recording when no prepared turn exists", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const runtime = createGitMemoryChatContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });

      await expect(runtime.recordAssistantMessage({
        clientId: "local",
        turn: null,
        message: "Nothing to record.",
        at: "2026-06-28T09:00:00+05:30",
      })).resolves.toBeNull();
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});

function parseJsonl(value: string | null): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}
