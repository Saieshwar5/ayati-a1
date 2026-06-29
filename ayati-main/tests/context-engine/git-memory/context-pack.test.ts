import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GitMemoryContextReader,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
} from "../../../src/context-engine/git-memory/index.js";

const execFileAsync = promisify(execFile);

describe("GitMemoryContextReader", () => {
  it("builds a session-only context pack before any user message or task", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack).toMatchObject({
      session: {
        sessionId: "S-20260628-local",
        conversationTail: [],
        taskMessageLinkTail: [],
        taskCount: 0,
      },
      focus: { status: "none" },
    });
    expect(pack.session.eventTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
    ]);
    expect(pack.task).toBeUndefined();
  });

  it("builds an active task context from working session files and committed task branch files", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
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
      summary: "Inspected upload handling and found validation mismatch.",
      actions: [{
        actionId: "ACT-20260628-000001",
        tool: "read_file",
        status: "completed",
        summary: "Read upload server implementation.",
      }],
      newFacts: ["UploadServer validates multipart uploads."],
      next: "Patch upload validation handling.",
      state: {
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling"],
        next: "Patch upload validation handling.",
      },
    });
    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Continue from there.",
      at: "2026-06-28T09:11:00+05:30",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
      limits: {
        conversationTailLimit: 3,
        eventTailLimit: 4,
        taskMessageLinkLimit: 3,
        runLimit: 3,
        commitLogLimit: 3,
        conversationMarkdownCharLimit: 200,
      },
    });

    expect(pack.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect upload handling." },
      { seq: 3, role: "user", text: "Continue from there." },
    ]);
    expect(pack.session.conversationMarkdownTail).toContain("Fix upload handling");
    expect(pack.session.conversationMarkdownTail).toContain("Continue from there.");
    expect(pack.session.eventTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
      { seq: 2, type: "task_created" },
      { seq: 3, type: "focus_changed" },
      { seq: 4, type: "run_completed" },
    ]);
    expect(pack.session.taskMessageLinkTail).toMatchObject([
      { linkId: "L-20260628-000001", taskId: "W-20260628-0001", fromSeq: 1, toSeq: 2 },
    ]);
    expect(pack.focus).toMatchObject({
      status: "active",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      ref: "refs/heads/task/W-20260628-0001-fix-upload-handling",
    });
    expect(pack.task).toMatchObject({
      taskId: "W-20260628-0001",
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      status: "in_progress",
      summary: "Inspected upload handling and found validation mismatch.",
      completed: ["Inspected upload server"],
      open: ["Patch upload validation handling"],
      facts: ["UploadServer validates multipart uploads."],
      next: "Patch upload validation handling.",
    });
    expect(pack.task?.conversationMarkdownTail).toContain("Fix upload handling");
    expect(pack.task?.conversationMarkdownTail).toContain("I will inspect upload handling.");
    expect(pack.task?.conversationMarkdownTail).not.toContain("Continue from there.");
    expect(pack.task?.conversation).toMatchObject([{
      link: { fromSeq: 1, toSeq: 2 },
      messages: [
        { seq: 1, role: "user", text: "Fix upload handling" },
        { seq: 2, role: "assistant", text: "I will inspect upload handling." },
      ],
    }]);
    expect(pack.task?.recentRuns).toMatchObject([{
      runId: "R-20260628-0001",
      status: "completed",
      summary: "Inspected upload handling and found validation mismatch.",
      toolCallCount: 1,
    }]);
    expect(pack.task?.recentCommits[0]).toMatchObject({
      subject: "ayati: complete run R-20260628-0001",
      trailers: {
        sessionId: "S-20260628-local",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
        event: "run_completed",
      },
    });
    expect(pack.task?.recentCommits[1]).toMatchObject({
      subject: "ayati: create task W-20260628-0001",
    });
  });

  it("prefers the current task branch over a stale focus file", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const uploadUser = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const uploadTask = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: uploadUser.seq,
      toSeq: uploadUser.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: uploadTask.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: uploadUser.seq, toSeq: uploadUser.seq }],
      summary: "Inspected upload handling.",
      state: {
        status: "in_progress",
        summary: "Inspected upload handling.",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        next: "Patch upload validation handling.",
      },
    });
    const reminderUser = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix reminder scheduling",
      at: "2026-06-28T10:00:00+05:30",
    });
    const reminderTask = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix reminder scheduling",
      objective: "Investigate reminder scheduling drift.",
      fromSeq: reminderUser.seq,
      toSeq: reminderUser.seq,
      at: "2026-06-28T10:01:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const mainLogBefore = await driver.log(GIT_MEMORY_MAIN_REF, 10);
    const uploadLogBefore = await driver.log(uploadTask.ref, 10);
    const reminderLogBefore = await driver.log(reminderTask.ref, 10);

    await execFileAsync("git", ["-C", session.repoPath, "symbolic-ref", "HEAD", uploadTask.ref]);

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.focus).toMatchObject({
      status: "active",
      taskId: uploadTask.taskId,
      branch: uploadTask.branch,
      ref: uploadTask.ref,
    });
    expect(pack.task).toMatchObject({
      taskId: uploadTask.taskId,
      title: "Fix upload handling",
      summary: "Inspected upload handling.",
      next: "Patch upload validation handling.",
    });
    expect(pack.task?.taskId).not.toBe(reminderTask.taskId);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(uploadTask.ref, 10)).toEqual(uploadLogBefore);
    expect(await driver.log(reminderTask.ref, 10)).toEqual(reminderLogBefore);
  });
});
