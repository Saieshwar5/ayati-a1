import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitContextMemoryStateHydrator,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
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
        sessionId: "S-20260628-local",
        conversationTail: [],
        taskMessageLinkTail: [],
        recentCommits: [{
          subject: "ayati: initialize session S-20260628-local",
        }],
        taskCount: 0,
      },
      focus: { status: "none" },
      knownTasks: [],
    });
    expect(state.session.eventTail).toMatchObject([
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
        eventTailLimit: 2,
        taskMessageLinkLimit: 1,
        runLimit: 1,
        commitLogLimit: 1,
        evidenceLimit: 1,
        conversationMarkdownCharLimit: 200,
      },
    });

    expect(state.session).toMatchObject({
      sessionId: "S-20260628-local",
      taskCount: 1,
      currentBranch: prepared.task.branch,
      conversationTail: [{
        seq: 2,
        role: "assistant",
        text: "I will inspect upload handling.",
      }],
      taskMessageLinkTail: [],
      recentCommits: [{
        subject: "ayati: initialize session S-20260628-local",
      }],
    });
    expect(state.session.conversationMarkdownTail).toContain("Fix upload handling");
    expect(state.session.conversationMarkdownTail).toContain("I will inspect upload handling.");
    expect(state.session.eventTail).toHaveLength(2);
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
  });

  it("ignores stale focus files while keeping missing task branches in known tasks", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-state-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_TASKS_PATH]: `${JSON.stringify({
        schemaVersion: 1,
        tasks: [{
          taskId: "W-20260628-0001",
          branch: "task/W-20260628-0001-missing",
          title: "Missing branch task",
          status: "open",
          createdAt: "2026-06-28T09:00:00+05:30",
          updatedAt: "2026-06-28T09:00:00+05:30",
        }],
      }, null, 2)}\n`,
      [GIT_MEMORY_SESSION_FOCUS_PATH]: `${JSON.stringify({
        schemaVersion: 1,
        activeTaskId: "W-20260628-0001",
        activeBranch: "task/W-20260628-0001-missing",
        updatedAt: "2026-06-28T09:00:00+05:30",
        reason: "test_missing_branch",
      }, null, 2)}\n`,
    });

    const state = await createGitContextMemoryStateHydrator(store).hydrate({
      sessionId: session.sessionId,
    });

    expect(state.focus).toEqual({ status: "none" });
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
    turnId: user.turnId,
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
  await store.commitTaskRun({
    sessionId: session.sessionId,
    taskId: task.taskId,
    status: "completed",
    startedAt: "2026-06-28T09:02:00+05:30",
    completedAt: "2026-06-28T09:10:00+05:30",
    conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
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
    summary: "Patched upload validation handling.",
    newFacts: ["Upload validation handles multipart MIME metadata."],
    next: "Verify upload validation patch.",
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
