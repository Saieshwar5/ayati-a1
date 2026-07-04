import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGitMemoryContextPackFromMemoryState,
  createGitContextMemoryStateHydrator,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  renderGitMemoryCommitMessage,
} from "../../../src/context-engine/git-memory/index.js";

describe("GitContextMemoryStateHydrator", () => {
  it("hydrates a session-only memory state", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-state-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    const state = await createGitContextMemoryStateHydrator(store).hydrate({
      sessionId: session.sessionId,
    });

    expect(state).toMatchObject({
      session: {
        meta: {
          sessionId: "S-20260628-local",
          date: "2026-06-28",
          timezone: "Asia/Kolkata",
          createdAt: "2026-06-28T00:00:00+05:30",
          repoKind: "daily_session",
          agentId: "local",
          assetCount: 0,
        },
        conversationTail: [],
        recentCommits: [{
          subject: "ayati: initialize session S-20260628-local",
        }],
        taskCount: 0,
      },
      pendingWrites: [],
      focus: { status: "none" },
      knownTasks: [],
    });
    expect(state.session).not.toHaveProperty("sessionId");
    expect(state.session).not.toHaveProperty("assetCount");
    expect(state.session.activityTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
    ]);
    expect(state.activeTask).toBeUndefined();
    expect(state.session.currentBranch).toBeUndefined();
  });

  it("hydrates active task state and known task summaries with bounded tails", async () => {
    const prepared = await prepareMemoryStateSession();

    const state = await createGitContextMemoryStateHydrator(prepared.store).hydrate({
      sessionId: prepared.session.sessionId,
      limits: {
        conversationTailLimit: 1,
        activityTailLimit: 2,
        runLimit: 1,
        commitLogLimit: 1,
        evidenceLimit: 1,
        conversationMarkdownCharLimit: 200,
      },
    });

    expect(state.session).toMatchObject({
      meta: {
        sessionId: "S-20260628-local",
        assetCount: 0,
      },
      taskCount: 1,
      currentBranch: prepared.task.branch,
      conversationTail: [{
        seq: 2,
        role: "assistant",
        text: "I will inspect upload handling.",
      }],
    });
    expect(state.session.recentCommits[0]).toMatchObject({
      subject: "ayati: initialize session S-20260628-local",
      event: "session_initialized",
    });
    expect(state.session.recentCommits[0]).not.toHaveProperty("trailers");
    expect(state.session.recentCommits[0]).not.toHaveProperty("conversationSeq");
    expect(state.session.conversationMarkdownTail).toContain("Fix upload handling");
    expect(state.session.conversationMarkdownTail).toContain("I will inspect upload handling.");
    expect(state.session.activityTail).toHaveLength(2);
    expect(state.focus).toMatchObject({
      status: "active",
      taskId: prepared.task.taskId,
      branch: prepared.task.branch,
    });
    expect(state.activeTask).toMatchObject({
      taskId: prepared.task.taskId,
      branch: prepared.task.branch,
      title: "Fix upload handling",
      status: "in_progress",
      summary: "Patched upload validation handling.",
      completed: ["Inspected upload server", "Patched upload validation handling"],
      open: ["Verify upload validation patch."],
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
      facts: [
        "Upload route validates MIME type.",
        "Upload validation handles multipart MIME metadata.",
      ],
      next: "Verify upload validation patch.",
      recentRuns: [{
        runId: "R-20260628-0002",
        summary: "Patched upload validation handling.",
      }],
      recentCommits: [{
        subject: "ayati: complete run R-20260628-0002",
      }],
      recentEvidence: [{
        runId: "R-20260628-0002",
        taskId: prepared.task.taskId,
        tool: "edit_file",
        summary: "Patched upload validation handling.",
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload validation handles multipart MIME metadata."],
      }],
    });
    expect(state.activeTask?.conversationMarkdownTail).toContain("Fix upload handling");
    expect(state.activeTask?.conversationMarkdownTail).toContain("I will inspect upload handling.");
    expect(state.activeTask?.recentRuns).toHaveLength(1);
    expect(state.activeTask?.recentCommits).toHaveLength(1);
    expect(state.activeTask?.recentEvidence).toHaveLength(1);
    expect(state.knownTasks).toMatchObject([{
      taskId: prepared.task.taskId,
      branch: prepared.task.branch,
      title: "Fix upload handling",
      status: "in_progress",
      summary: "Patched upload validation handling.",
      next: "Verify upload validation patch.",
    }]);

    const context = buildGitMemoryContextPackFromMemoryState(state);
    expect(context.pendingWrites).toBeUndefined();
    expect(context).toMatchObject({
      session: {
        meta: {
          sessionId: "S-20260628-local",
          assetCount: 0,
        },
        taskCount: 1,
      },
      focus: {
        status: "active",
        taskId: prepared.task.taskId,
      },
      task: {
        taskId: prepared.task.taskId,
        branch: prepared.task.branch,
        title: "Fix upload handling",
        status: "in_progress",
        summary: "Patched upload validation handling.",
      },
    });
  });

  it("marks a current task branch missing when HEAD points at a branch without task files", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-state-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.commitSyntheticFiles({
      ref: "refs/heads/task/W-20260628-0001-missing",
      files: {
        "tasks/W-20260628-0001/notes.md": "# Missing branch task\n",
      },
      message: renderGitMemoryCommitMessage({
        subject: "ayati: create incomplete task W-20260628-0001",
        summary: "Create a task branch without task.md or state.json.",
        trailers: {
          sessionId: session.sessionId,
          taskId: "W-20260628-0001",
          event: "task_created",
          at: "2026-06-28T09:00:00+05:30",
          branch: "task/W-20260628-0001-missing",
          schemaVersion: 1,
        },
      }),
    });
    await driver.checkoutBranch("refs/heads/task/W-20260628-0001-missing");

    const state = await createGitContextMemoryStateHydrator(store).hydrate({
      sessionId: session.sessionId,
    });

    expect(state.focus).toMatchObject({
      status: "missing",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-missing",
      reason: "focused task branch is missing task.md or state.json",
    });
    expect(state.activeTask).toBeUndefined();
    expect(state.knownTasks).toMatchObject([{
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-missing",
      missing: true,
    }]);
  });

  it("does not create a repo for missing sessions", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-state-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const sessionId = "S-20260628-local";

    await expect(createGitContextMemoryStateHydrator(store).hydrate({ sessionId }))
      .rejects.toThrow("Git memory session not found");
    await expect(access(join(contextStoreDir, "sessions", sessionId, ".git"))).rejects.toThrow();
  });
});

async function prepareMemoryStateSession(): Promise<{
  contextStoreDir: string;
  store: GitMemoryDailySessionStore;
  session: Awaited<ReturnType<GitMemoryDailySessionStore["openOrCreateDailySession"]>>;
  task: Awaited<ReturnType<GitMemoryDailySessionStore["createTaskBranch"]>>;
}> {
  const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-state-"));
  const store = new GitMemoryDailySessionStore({ contextStoreDir });
  const session = await store.openOrCreateDailySession({
    date: "2026-06-28",
    timezone: "Asia/Kolkata",
    agentId: "local",
    createdAt: "2026-06-28T00:00:00+05:30",
  });
  const user = await store.appendConversationMessage({
    sessionId: session.sessionId,
    role: "user",
    text: "Fix upload handling",
    at: "2026-06-28T09:00:00+05:30",
  });
  await store.appendConversationMessage({
    sessionId: session.sessionId,
    role: "assistant",
    text: "I will inspect upload handling.",
    at: "2026-06-28T09:00:05+05:30",
  });
  const task = await store.createTaskBranch({
    sessionId: session.sessionId,
    title: "Fix upload handling",
    objective: "Find and fix upload handling failures.",
    fromSeq: 1,
    toSeq: 2,
    at: "2026-06-28T09:01:00+05:30",
  });
  const snapshot = await store.commitSessionStoreSnapshot({
    sessionId: session.sessionId,
    at: "2026-06-28T09:01:30+05:30",
    summary: "Snapshot memory-state fixture conversation.",
  });
  await store.commitTaskRun({
    sessionId: session.sessionId,
    taskId: task.taskId,
    status: "completed",
    startedAt: "2026-06-28T09:02:00+05:30",
    completedAt: "2026-06-28T09:10:00+05:30",
    conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
    sessionStoreCommit: snapshot.sessionStoreCommit,
    summary: "Inspected upload handling.",
    newFacts: ["Upload route validates MIME type."],
    next: "Patch upload validation handling.",
    state: {
      status: "in_progress",
      completed: ["Inspected upload server"],
      open: ["Patch upload validation handling."],
      next: "Patch upload validation handling.",
    },
  });
  await store.commitTaskRun({
    sessionId: session.sessionId,
    taskId: task.taskId,
    status: "completed",
    startedAt: "2026-06-28T09:12:00+05:30",
    completedAt: "2026-06-28T09:20:00+05:30",
    conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
    sessionStoreCommit: snapshot.sessionStoreCommit,
    summary: "Patched upload validation handling.",
    newFacts: ["Upload validation handles multipart MIME metadata."],
    next: "Verify upload validation patch.",
    assets: [{
      assetId: "asset-upload-log",
      role: "reference",
      kind: "file",
      name: "upload.log",
      path: "/tmp/upload.log",
    }],
    evidence: [{
      step: 2,
      tool: "edit_file",
      status: "completed",
      summary: "Patched upload validation handling.",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: ["Upload validation handles multipart MIME metadata."],
      accessModes: ["summary"],
      source: { kind: "test" },
    }],
    state: {
      status: "in_progress",
      summary: "Patched upload validation handling.",
      completed: ["Inspected upload server", "Patched upload validation handling"],
      open: ["Verify upload validation patch."],
      next: "Verify upload validation patch.",
    },
  });
  return { contextStoreDir, store, session, task };
}
