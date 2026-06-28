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
  gitMemoryTaskRunPath,
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

  it("routes prepared user turns to git-memory task branches", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const runtime = createGitMemoryChatContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });
      const first = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });

      const created = await runtime.routeTaskTurn({
        clientId: "local",
        turn: first,
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:01+05:30",
      });

      expect(created).toMatchObject({
        status: "ready",
        mode: "create_new_task",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
        conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
        harnessContext: {
          contextEngine: {
            focus: {
              status: "active",
              workId: "W-20260628-0001",
            },
            task: {
              workId: "W-20260628-0001",
              title: "Fix upload handling",
              open: ["Fix upload handling"],
              facts: [],
              assets: [],
            },
          },
        },
        context: {
          focus: {
            status: "active",
            taskId: "W-20260628-0001",
          },
        },
      });

      const second = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "finish it",
        at: "2026-06-28T09:05:00+05:30",
      });
      const continued = await runtime.routeTaskTurn({
        clientId: "local",
        turn: second,
        userMessage: "finish it",
        at: "2026-06-28T09:05:01+05:30",
      });

      expect(continued).toMatchObject({
        status: "ready",
        mode: "continue_active_task",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0002",
        conversationRefs: [{ fromSeq: 2, toSeq: 2 }],
        harnessContext: {
          contextEngine: {
            session: {
              conversationTail: [
                { seq: 1, role: "user", text: "Fix upload handling" },
                { seq: 2, role: "user", text: "finish it" },
              ],
            },
            task: {
              workId: "W-20260628-0001",
              assets: [],
            },
          },
        },
        context: {
          task: {
            conversation: [
              { link: { reason: "task_created", fromSeq: 1, toSeq: 1 } },
              { link: { reason: "task_continued", fromSeq: 2, toSeq: 2, runId: "R-20260628-0002" } },
            ],
          },
        },
      });
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("commits completed task runs through the git-memory bridge", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-chat-context-"));
    try {
      const gitMemoryRuntime = createGitMemoryRuntime({
        contextStoreDir: storeDir,
        timezone: "Asia/Kolkata",
        agentId: "local",
      });
      const runtime = createGitMemoryChatContextRuntime({ gitMemoryRuntime });
      const prepared = await runtime.prepareUserTurn({
        clientId: "local",
        userMessage: "Fix upload handling",
        at: "2026-06-28T09:00:00+05:30",
      });
      const task = await gitMemoryRuntime.createTaskBranch({
        sessionId: prepared.sessionId,
        title: "Fix upload handling",
        objective: "Find and fix upload handling failures.",
        fromSeq: prepared.messageSeq,
        toSeq: prepared.messageSeq,
        at: "2026-06-28T09:01:00+05:30",
      });

      const committed = await runtime.completeTaskRun({
        clientId: "local",
        turn: prepared,
        taskId: task.taskId,
        result: {
          type: "reply",
          status: "completed",
          content: "I inspected upload handling and found the next patch.",
          totalIterations: 2,
          totalToolCalls: 2,
          runPath: "data/runs/r1",
          taskSummary: {
            taskStatus: "open",
            summary: "Inspected upload handling.",
            openWork: ["Patch upload validation handling."],
            nextAction: "Patch upload validation handling.",
          },
          workState: {
            status: "not_done",
            summary: "Upload handling inspection is complete.",
            openWork: ["Patch upload validation handling."],
            blockers: [],
            verifiedFacts: ["Upload route validates MIME type."],
            evidence: ["upload-server.ts"],
            nextStep: "Patch upload validation handling.",
          },
          completedSteps: [{
            step: 1,
            outcome: "success",
            summary: "Read upload server implementation.",
            newFacts: ["Upload route validates MIME type."],
            artifacts: ["ayati-main/src/server/upload-server.ts"],
            toolsUsed: ["read_file"],
          }],
        },
        startedAt: "2026-06-28T09:02:00+05:30",
        at: "2026-06-28T09:10:00+05:30",
      });

      expect(committed).toMatchObject({
        taskId: "W-20260628-0001",
        branch: "task/W-20260628-0001-fix-upload-handling",
        runId: "R-20260628-0001",
        event: {
          type: "run_completed",
          conversationSeq: { fromSeq: prepared.messageSeq, toSeq: prepared.messageSeq },
        },
      });
      if (!committed) {
        throw new Error("Expected git-memory bridge to commit the task run.");
      }

      const runId = committed.runId;
      const assistant = await runtime.recordAssistantMessage({
        clientId: "local",
        turn: prepared,
        message: "I inspected upload handling and found the next patch.",
        taskId: task.taskId,
        runId,
        at: "2026-06-28T09:10:05+05:30",
      });
      expect(assistant).toMatchObject({
        seq: 2,
        taskId: task.taskId,
        runId,
      });

      const context = await runtime.buildActiveContext(prepared.sessionId);
      expect(context.task).toMatchObject({
        taskId: "W-20260628-0001",
        status: "in_progress",
        summary: "Upload handling inspection is complete.",
        completed: ["Read upload server implementation."],
        open: ["Patch upload validation handling."],
        recentRuns: [{
          runId: "R-20260628-0001",
          status: "completed",
          summary: "Inspected upload handling.",
          toolCallCount: 2,
        }],
      });

      const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
      expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskRunPath(task.taskId, runId)) ?? "{}"))
        .toMatchObject({
          runId,
          toolCallCount: 2,
          conversationRefs: [{ fromSeq: prepared.messageSeq, toSeq: prepared.messageSeq }],
          changedFiles: ["ayati-main/src/server/upload-server.ts"],
          newFacts: ["Upload route validates MIME type."],
        });
      expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
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
