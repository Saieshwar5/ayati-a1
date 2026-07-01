import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemoryTaskIdFromBranch,
  nextGitMemoryTaskSequence,
  readGitMemoryTaskEntries,
  readGitMemorySessionTaskEntries,
  renderGitMemoryCommitMessage,
  resolveGitMemoryTaskEntry,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory task refs", () => {
  it("parses task ids from task branch names", () => {
    expect(gitMemoryTaskIdFromBranch("task/W-20260628-0001-fix-upload")).toBe("W-20260628-0001");
    expect(gitMemoryTaskIdFromBranch("task/W-20260628-0001")).toBe("W-20260628-0001");
    expect(gitMemoryTaskIdFromBranch("main")).toBeNull();
    expect(gitMemoryTaskIdFromBranch("task/not-a-task")).toBeNull();
  });

  it("lists task entries from git branches and ignores malformed task refs", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-task-refs-"));
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
    await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Analyze contract risk",
      objective: "Review contract risk.",
      fromSeq: 2,
      toSeq: 2,
      at: "2026-06-28T09:05:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.commitSyntheticFiles({
      ref: "refs/heads/task/not-a-task",
      files: { "README.md": "ignore this branch\n" },
      message: "ayati: malformed task ref",
    });

    const entries = await readGitMemoryTaskEntries(driver);

    expect(entries.map((entry) => entry.taskId)).toEqual([
      "W-20260628-0001",
      "W-20260628-0002",
    ]);
    expect(entries[0]).toMatchObject({
      taskId: first.taskId,
      branch: first.branch,
      ref: first.ref,
      title: "Fix upload handling",
      status: "open",
    });
    expect(nextGitMemoryTaskSequence(entries)).toBe(3);
  });

  it("lists session task entries from git-native session task refs", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-task-refs-"));
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
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    const entries = await readGitMemorySessionTaskEntries(driver, session.sessionId);

    expect(entries).toMatchObject([{
      taskId: task.taskId,
      branch: task.branch,
      ref: `refs/ayati/sessions/${session.sessionId}/tasks/${task.taskId}`,
      title: "Fix upload handling",
      status: "open",
    }]);
  });

  it("marks task branches missing when task files are incomplete", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-task-refs-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.commitSyntheticFiles({
      ref: "refs/heads/task/W-20260628-0004-incomplete",
      files: {
        "tasks/W-20260628-0004/notes.md": "# Incomplete\n",
      },
      message: renderGitMemoryCommitMessage({
        subject: "ayati: create incomplete task W-20260628-0004",
        summary: "Create an incomplete task branch.",
        trailers: {
          sessionId: session.sessionId,
          taskId: "W-20260628-0004",
          event: "task_created",
          at: "2026-06-28T09:00:00+05:30",
          branch: "task/W-20260628-0004-incomplete",
          schemaVersion: 1,
        },
      }),
    });

    const entries = await readGitMemoryTaskEntries(driver);

    expect(entries).toMatchObject([{
      taskId: "W-20260628-0004",
      branch: "task/W-20260628-0004-incomplete",
      title: "W-20260628-0004",
      status: "open",
      missing: true,
    }]);
    expect(nextGitMemoryTaskSequence(entries)).toBe(5);
  });

  it("resolves tasks by task id or branch", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-task-refs-"));
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
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    await expect(resolveGitMemoryTaskEntry(driver, { taskId: task.taskId }))
      .resolves.toMatchObject({ taskId: task.taskId, branch: task.branch });
    await expect(resolveGitMemoryTaskEntry(driver, { branch: task.branch }))
      .resolves.toMatchObject({ taskId: task.taskId, branch: task.branch });
    await expect(resolveGitMemoryTaskEntry(driver, {}))
      .rejects.toThrow("Provide exactly one task selector");
  });
});
