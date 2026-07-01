import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionActiveTaskRef,
  gitMemorySessionLatestBaseRef,
  gitMemorySessionLatestRunRef,
  gitMemoryTaskLatestRunRef,
  readGitMemoryCustomRef,
  writeGitMemoryCustomRef,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory custom refs", () => {
  it("tracks latest-base on session init and main conversation appends", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-custom-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    await expect(readGitMemoryCustomRef(driver, gitMemorySessionLatestBaseRef(session.sessionId)))
      .resolves.toBe(session.initialCommit);

    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });

    await expect(readGitMemoryCustomRef(driver, gitMemorySessionLatestBaseRef(session.sessionId)))
      .resolves.toBe(await driver.resolveRef(GIT_MEMORY_MAIN_REF));
  });

  it("creates new task branches from latest-base instead of the active task branch", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-custom-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const firstMessage = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const first = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: firstMessage.seq,
      toSeq: firstMessage.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: first.taskId,
      runId: "R-20260628-0001",
      status: "completed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: firstMessage.seq, toSeq: firstMessage.seq }],
      summary: "Finished upload work.",
      state: {
        status: "done",
        summary: "Upload work is done.",
        completed: ["Finished upload work."],
        open: [],
        blockers: [],
        facts: [],
        next: "No follow-up.",
      },
    });
    const secondMessage = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Review billing copy",
      at: "2026-06-28T09:20:00+05:30",
    });
    const second = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Review billing copy",
      objective: "Review the billing page copy.",
      fromSeq: secondMessage.seq,
      toSeq: secondMessage.seq,
      at: "2026-06-28T09:21:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    expect(await driver.readFile(second.ref, `tasks/${first.taskId}/runs/R-20260628-0001.json`)).toBeNull();
    expect(await driver.readFile(second.ref, `tasks/${second.taskId}/task.md`)).toContain("Review billing copy");
    await expect(readGitMemoryCustomRef(driver, gitMemorySessionLatestBaseRef(session.sessionId)))
      .resolves.toBe(await driver.resolveRef(GIT_MEMORY_MAIN_REF));
  });

  it("tracks the active task through task creation and selection", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-custom-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const first = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:00:00+05:30",
    });
    const second = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Review billing copy",
      objective: "Review the billing page copy.",
      fromSeq: 2,
      toSeq: 2,
      at: "2026-06-28T09:05:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    await expect(readGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(session.sessionId)))
      .resolves.toBe(second.taskCommit);

    await store.selectTaskForTurn({
      sessionId: session.sessionId,
      taskId: first.taskId,
      reason: "task_switched",
      fromSeq: 0,
      toSeq: 0,
      at: "2026-06-28T09:10:00+05:30",
    });
    await driver.checkoutBranch(GIT_MEMORY_MAIN_REF);

    await expect(readGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(session.sessionId)))
      .resolves.toBe(first.taskCommit);
    await expect(store.listSessions())
      .resolves.toMatchObject([{
        sessionId: session.sessionId,
        activeTaskId: first.taskId,
        activeBranch: first.branch,
      }]);
    await expect(store.readTaskRoutingSnapshot(session.sessionId))
      .resolves.toMatchObject({
        focus: {
          activeTaskId: first.taskId,
          activeBranch: first.branch,
        },
      });
  });

  it("tracks the latest run for the session and task", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-custom-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:00:00+05:30",
    });

    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0001",
      status: "completed",
      startedAt: "2026-06-28T09:00:00+05:30",
      completedAt: "2026-06-28T09:15:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Fixed upload handling.",
      changedFiles: ["src/upload.ts"],
      state: {
        status: "done",
        summary: "Upload handling is fixed.",
        completed: ["Fixed upload handling."],
        open: [],
        blockers: [],
        facts: ["Upload handling failure was resolved."],
        next: "Verify in integration flow.",
      },
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    await expect(readGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(session.sessionId)))
      .resolves.toBe(run.taskCommit);
    await expect(readGitMemoryCustomRef(driver, gitMemorySessionLatestRunRef(session.sessionId)))
      .resolves.toBe(run.taskCommit);
    await expect(readGitMemoryCustomRef(driver, gitMemoryTaskLatestRunRef(task.taskId)))
      .resolves.toBe(run.taskCommit);
  });

  it("rejects writes outside the git memory custom ref namespace", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-custom-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    await expect(writeGitMemoryCustomRef(driver, "refs/heads/main", GIT_MEMORY_MAIN_REF))
      .rejects.toThrow("Git memory custom refs must be under refs/ayati/");
  });
});
