import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitMemoryRuntime,
} from "../../src/context-engine/index.js";
import { createGitMemorySystemEventContextRuntime } from "../../src/app/git-memory-system-event-context-runtime.js";

describe("createGitMemorySystemEventContextRuntime", () => {
  it("records system events, routes them to task runs, and records assistant output", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-system-context-"));
    try {
      const runtime = createGitMemorySystemEventContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });

      const prepared = await runtime.prepareSystemEventTurn({
        clientId: "local",
        systemMessage: "System event: pulse/task_due\nSummary: Check health",
        at: "2026-06-28T09:00:00+05:30",
      });
      const routed = await runtime.routeTaskTurn({
        clientId: "local",
        turn: prepared,
        userMessage: "Check health",
        title: "Check health",
        objective: "Handle scheduled health check.",
        at: "2026-06-28T09:00:01+05:30",
      });

      expect(prepared).toMatchObject({
        sessionId: "S-20260628-local",
        messageSeq: 1,
        memoryState: {
          focus: { status: "none" },
          knownTasks: [],
        },
      });
      expect(routed).toMatchObject({
        status: "ready",
        mode: "create_new_task",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
        conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
        memoryState: {
          focus: {
            status: "active",
            taskId: "W-20260628-0001",
          },
          activeTask: {
            taskId: "W-20260628-0001",
            title: "Check health",
          },
        },
      });
      expect(routed?.harnessContext.contextEngine.task?.workId)
        .toBe(routed?.memoryState.activeTask?.taskId);

      if (routed?.status !== "ready") {
        throw new Error("Expected ready route.");
      }

      const completed = await runtime.completeTaskRun({
        clientId: "local",
        turn: prepared,
        taskId: routed.taskId,
        runId: routed.runId,
        result: {
          type: "notification",
          runClass: "task",
          content: "Health checked.",
          status: "completed",
          totalIterations: 1,
          totalToolCalls: 0,
          runPath: "/tmp/run",
          workRunId: routed.runId,
          completedSteps: [],
        },
        conversationRefs: routed.conversationRefs,
        at: "2026-06-28T09:05:00+05:30",
      });
      await runtime.recordAssistantMessage({
        clientId: "local",
        turn: prepared,
        message: "Health checked.",
        taskId: routed.taskId,
        runId: routed.runId,
        at: "2026-06-28T09:05:01+05:30",
      });

      expect(completed).toMatchObject({
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
      });
      const context = await runtime.buildActiveContext(prepared.sessionId);
      expect(context.session.conversationTail).toMatchObject([
        { seq: 1, role: "system", text: expect.stringContaining("pulse/task_due") },
        { seq: 2, role: "assistant", taskId: "W-20260628-0001", runId: "R-20260628-0001" },
      ]);
      expect(context.task?.recentRuns).toMatchObject([
        { runId: "R-20260628-0001", status: "completed", assistantResponse: "Health checked." },
      ]);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("surfaces duplicate task run commit failures from the git-memory bridge", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "ayati-git-memory-system-context-"));
    try {
      const runtime = createGitMemorySystemEventContextRuntime({
        gitMemoryRuntime: createGitMemoryRuntime({
          contextStoreDir: storeDir,
          timezone: "Asia/Kolkata",
          agentId: "local",
        }),
      });

      const prepared = await runtime.prepareSystemEventTurn({
        clientId: "local",
        systemMessage: "System event: pulse/task_due\nSummary: Check health",
        at: "2026-06-28T09:00:00+05:30",
      });
      const routed = await runtime.routeTaskTurn({
        clientId: "local",
        turn: prepared,
        userMessage: "Check health",
        title: "Check health",
        objective: "Handle scheduled health check.",
        at: "2026-06-28T09:00:01+05:30",
      });
      if (routed?.status !== "ready") {
        throw new Error("Expected ready route.");
      }

      const result = {
        type: "notification" as const,
        content: "Health checked.",
        status: "completed" as const,
        totalIterations: 1,
        totalToolCalls: 0,
        runPath: "/tmp/run",
        workRunId: routed.runId,
        completedSteps: [],
      };

      await runtime.completeTaskRun({
        clientId: "local",
        turn: prepared,
        taskId: routed.taskId,
        runId: routed.runId,
        result,
        conversationRefs: routed.conversationRefs,
        at: "2026-06-28T09:05:00+05:30",
      });

      await expect(runtime.completeTaskRun({
        clientId: "local",
        turn: prepared,
        taskId: routed.taskId,
        runId: routed.runId,
        result,
        conversationRefs: routed.conversationRefs,
        at: "2026-06-28T09:06:00+05:30",
      })).rejects.toThrow(`Git memory task run already committed: ${routed.runId}`);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
