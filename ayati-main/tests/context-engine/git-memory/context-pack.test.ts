import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
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
        recentCommits: [{
          subject: "ayati: initialize session S-20260628-local",
        }],
        taskCount: 0,
      },
      focus: { status: "none" },
    });
    expect(pack.session.activityTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
    ]);
    expect(pack.task).toBeUndefined();
  });

  it("prefers markdown conversation over jsonl for model-facing session context", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "This jsonl text should not be used",
      at: "2026-06-28T09:00:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: [
        "# Conversation",
        "",
        "## 2026-06-28T09:15:00+05:30 User",
        "",
        "Read this from Markdown.",
        "",
        "## 2026-06-28T09:16:00+05:30 Assistant",
        "",
        "Markdown is canonical for context.",
        "",
      ].join("\n"),
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Read this from Markdown." },
      { seq: 2, role: "assistant", text: "Markdown is canonical for context." },
    ]);
  });

  it("falls back to jsonl conversation when markdown has no conversation blocks", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fallback from jsonl.",
      at: "2026-06-28T09:00:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: "# Conversation\n",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fallback from jsonl." },
    ]);
  });

  it("can build session conversation context when jsonl is empty", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.writeWorkingFiles({
      [GIT_MEMORY_SESSION_CONVERSATION_PATH]: "",
      [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: [
        "# Conversation",
        "",
        "## 2026-06-28T09:15:00+05:30 User",
        "",
        "Task: W-20260628-0001",
        "Branch: task/W-20260628-0001-fix-upload-handling",
        "",
        "Only Markdown exists.",
        "",
      ].join("\n"),
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.conversationTail).toMatchObject([
      {
        seq: 1,
        role: "user",
        text: "Only Markdown exists.",
        taskId: "W-20260628-0001",
        branch: "task/W-20260628-0001-fix-upload-handling",
      },
    ]);
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
      evidence: [{
        step: 1,
        actionId: "ACT-20260628-000001",
        tool: "read_file",
        status: "completed",
        summary: "Read upload server implementation.",
        evidenceRef: "evidence/ACT-20260628-000001.txt",
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload server implementation was inspected."],
        accessModes: ["summary"],
        outputSize: 1200,
        lineCount: 80,
        truncated: false,
        source: {
          kind: "tool-output",
          toolCalls: [{
            kind: "tool-output",
            tool: "read_file",
            callId: "call-read-upload",
            filePath: "ayati-main/src/server/upload-server.ts",
            rawOutputPath: "raw/001-call-read-upload-read_file.txt",
          }],
        },
      }],
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
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
        activityTailLimit: 4,
        runLimit: 3,
        evidenceLimit: 3,
        commitLogLimit: 3,
        conversationMarkdownCharLimit: 200,
      },
    });

    expect(pack.session.conversationTail).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect upload handling." },
      { seq: 3, role: "user", text: "Continue from there." },
    ]);
    expect(pack.session.conversationMarkdownTail).toContain("Continue from there.");
    expect(pack.session.conversationMarkdownTail).toContain("Branch: task/W-20260628-0001-fix-upload-handling");
    expect(pack.session.activityTail).toMatchObject([
      { seq: 1, type: "task_created" },
      { seq: 2, type: "run_completed" },
    ]);
    expect(pack.session.recentCommits[0]).toMatchObject({
      subject: "ayati: record user message",
      trailers: {
        sessionId: "S-20260628-local",
        event: "conversation_appended",
      },
    });
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
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
    });
    expect(pack.task?.conversationMarkdownTail).toContain("Fix upload handling");
    expect(pack.task?.conversationMarkdownTail).toContain("I will inspect upload handling.");
    expect(pack.task?.conversationMarkdownTail).not.toContain("Continue from there.");
    expect(pack.task?.recentRuns).toMatchObject([{
      runId: "R-20260628-0001",
      status: "completed",
      summary: "Inspected upload handling and found validation mismatch.",
      toolCallCount: 1,
    }]);
    expect(pack.task?.recentEvidence).toMatchObject([{
      runId: "R-20260628-0001",
      taskId: "W-20260628-0001",
      actionId: "ACT-20260628-000001",
      tool: "read_file",
      summary: "Read upload server implementation.",
      evidenceRef: "evidence/ACT-20260628-000001.txt",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: ["Upload server implementation was inspected."],
      outputSize: 1200,
      lineCount: 80,
      truncated: false,
      source: {
        kind: "tool-output",
        toolCalls: [{
          kind: "tool-output",
          tool: "read_file",
          callId: "call-read-upload",
          filePath: "ayati-main/src/server/upload-server.ts",
          rawOutputPath: "raw/001-call-read-upload-read_file.txt",
        }],
      },
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

  it("derives active session event context from commit history without an events file", async () => {
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
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
      summary: "Inspected upload handling.",
      state: {
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        next: "Patch upload validation handling.",
      },
    });
    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.activityTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
      {
        seq: 2,
        type: "task_created",
        taskId: task.taskId,
        branch: task.branch,
      },
      {
        seq: 3,
        type: "run_completed",
        taskId: task.taskId,
        runId: run.runId,
        commit: run.taskCommit,
      },
    ]);
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
