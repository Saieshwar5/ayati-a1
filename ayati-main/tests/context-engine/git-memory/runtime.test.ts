import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitMemoryRuntime,
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GitMemoryWorktreeGitDriver,
  parseGitMemoryCommitTrailers,
  sessionDateForAt,
} from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryRuntime", () => {
  it("opens the daily session repo before any user message", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const first = await runtime.openDailySession({
      at: "2026-06-28T00:00:00+05:30",
    });
    const second = await runtime.openDailySession({
      at: "2026-06-28T00:01:00+05:30",
    });

    expect(first).toMatchObject({
      sessionId: "S-20260628-local",
      initialized: true,
    });
    expect(second).toMatchObject({
      sessionId: "S-20260628-local",
      repoPath: first.repoPath,
      initialized: false,
    });
    expect(await new GitMemoryWorktreeGitDriver(first.repoPath).log(GIT_MEMORY_MAIN_REF, 5))
      .toHaveLength(1);
  });

  it("prepares a user turn and records assistant output in the same canonical conversation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      turnId: prepared.userMessage.turnId,
      text: "I will inspect upload handling.",
      at: "2026-06-28T09:00:05+05:30",
    });

    expect(prepared).toMatchObject({
      status: "ready",
      sessionId: "S-20260628-local",
      userMessage: {
        seq: 1,
        messageId: "M-20260628-000001",
        turnId: "T-20260628-000001",
        role: "user",
      },
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
      memoryState: {
        session: {
          conversationTail: [{
            seq: 1,
            role: "user",
            text: "Fix upload handling",
          }],
          taskCount: 0,
        },
        focus: { status: "none" },
        knownTasks: [],
      },
    });
    expect(prepared.memoryState.activeTask).toBeUndefined();

    const context = await runtime.buildActiveContext(prepared.sessionId);
    expect(context.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect upload handling." },
    ]);

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(parseJsonl(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH)))
      .toHaveLength(2);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
  });

  it("uses timezone-aware dates when choosing the daily session repo", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });

    expect(sessionDateForAt("2026-06-27T20:00:00.000Z", "Asia/Kolkata")).toBe("2026-06-28");

    const prepared = await runtime.prepareUserTurn({
      userMessage: "This belongs to the India-local next day.",
      at: "2026-06-27T20:00:00.000Z",
    });

    expect(prepared.sessionId).toBe("S-20260628-local");
  });

  it("runs task creation and task-run commits through the runtime facade", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const prepared = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const task = await runtime.createTaskBranch({
      sessionId: prepared.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: prepared.userMessage.seq,
      toSeq: prepared.userMessage.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    const run = await runtime.commitTaskRun({
      sessionId: prepared.sessionId,
      taskId: task.taskId,
      status: "completed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: prepared.userMessage.seq, toSeq: prepared.userMessage.seq }],
      summary: "Finished upload handling inspection.",
      state: {
        status: "done",
        completed: ["Finished upload handling inspection"],
        open: [],
        next: "No next step.",
      },
    });
    await runtime.recordAssistantMessage({
      sessionId: prepared.sessionId,
      turnId: prepared.userMessage.turnId,
      taskId: task.taskId,
      runId: run.runId,
      text: "Finished upload handling inspection.",
      at: "2026-06-28T09:10:05+05:30",
    });

    const context = await runtime.buildActiveContext(prepared.sessionId);
    expect(context.focus).toMatchObject({
      status: "active",
      taskId: "W-20260628-0001",
    });
    expect(context.task).toMatchObject({
      taskId: "W-20260628-0001",
      status: "done",
      completed: ["Finished upload handling inspection"],
      recentRuns: [{
        runId: "R-20260628-0001",
        status: "completed",
        summary: "Finished upload handling inspection.",
      }],
    });
    expect(context.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      {
        seq: 2,
        role: "assistant",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
      },
    ]);

    const memoryState = await runtime.buildMemoryState(prepared.sessionId);
    expect(memoryState).toMatchObject({
      focus: {
        status: "active",
        taskId: "W-20260628-0001",
      },
      activeTask: {
        taskId: "W-20260628-0001",
        status: "done",
        completed: ["Finished upload handling inspection"],
      },
      knownTasks: [{
        taskId: "W-20260628-0001",
        status: "done",
      }],
    });

    await runtime.checkpointSession({
      sessionId: prepared.sessionId,
      summary: "Checkpoint runtime facade lifecycle.",
      at: "2026-06-28T09:11:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(prepared.repoPath);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(4);
  });

  it("appends routed follow-up messages to the selected task branch before run start", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-runtime-"));
    const runtime = createGitMemoryRuntime({
      contextStoreDir,
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    const first = await runtime.prepareUserTurn({
      userMessage: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const created = await runtime.routeUserTurn({
      sessionId: first.sessionId,
      userMessage: "Fix upload handling",
      fromSeq: first.userMessage.seq,
      toSeq: first.userMessage.seq,
      at: "2026-06-28T09:00:01+05:30",
      turnIds: [first.userMessage.turnId],
    });
    if (created.status !== "ready") {
      throw new Error(`Expected ready task route, got ${created.status}.`);
    }
    const second = await runtime.prepareUserTurn({
      userMessage: "finish it",
      at: "2026-06-28T09:05:00+05:30",
    });
    const continued = await runtime.routeUserTurn({
      sessionId: second.sessionId,
      userMessage: "finish it",
      fromSeq: second.userMessage.seq,
      toSeq: second.userMessage.seq,
      at: "2026-06-28T09:05:01+05:30",
      turnIds: [second.userMessage.turnId],
    });
    if (continued.status !== "ready") {
      throw new Error(`Expected ready task route, got ${continued.status}.`);
    }

    const driver = new GitMemoryWorktreeGitDriver(second.repoPath);
    const markdown = await driver.readFile(continued.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH) ?? "";
    expect(markdown).toContain("finish it");
    expect(markdown.match(/finish it/g)).toHaveLength(1);
    const taskLog = await driver.log(continued.ref, 5);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "conversation_appended",
      runId: continued.runId,
      conversationSeq: { fromSeq: second.userMessage.seq, toSeq: second.userMessage.seq },
    });
  });
});

function parseJsonl(value: string | null): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}
