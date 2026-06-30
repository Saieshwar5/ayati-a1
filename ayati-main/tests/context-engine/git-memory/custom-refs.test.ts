import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionActiveTaskRef,
  gitMemorySessionLatestRunRef,
  gitMemoryTaskLatestRunRef,
  readGitMemoryCustomRef,
  writeGitMemoryCustomRef,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory custom refs", () => {
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
