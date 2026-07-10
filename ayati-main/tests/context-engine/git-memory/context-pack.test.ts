import { mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  GIT_MEMORY_MAIN_REF,
  GitMemoryContextReader,
  GitMemoryDailySessionStore,
  GitMemoryWorktreeGitDriver,
  gitMemorySessionActiveTaskRef,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  gitMemoryTaskConversationMessagePath,
  renderGitMemorySessionSummaryMarkdown,
  renderGitMemorySessionSummaryMetadata,
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
      focus: { status: "none" },
    });
    expect(pack.session).not.toHaveProperty("sessionId");
    expect(pack.session).not.toHaveProperty("assetCount");
    expect(pack.session.activityTail).toMatchObject([
      { seq: 1, type: "session_initialized" },
    ]);
    expect(pack.task).toBeUndefined();
  });

  it("reads session summary files from the session-store submodule", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    await sessionStore.commitFiles({
      files: {
        [gitMemorySessionStoreSummaryMarkdownPath(session.sessionId)]: renderGitMemorySessionSummaryMarkdown(
          "The session is cleaning prompt context before adding summary updates.",
        ),
        [gitMemorySessionStoreSummaryMetaPath(session.sessionId)]: renderGitMemorySessionSummaryMetadata({
          schemaVersion: 1,
          sessionId: session.sessionId,
          updatedAt: "2026-06-28T09:30:00+05:30",
          coveredUntilSeq: 12,
          messageCount: 8,
        }),
      },
      message: "test: add session summary",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.summary).toEqual({
      text: "The session is cleaning prompt context before adding summary updates.",
      updatedAt: "2026-06-28T09:30:00+05:30",
      coveredUntilSeq: 12,
    });
  });

  it("keeps session summary text when summary metadata is missing or invalid", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const sessionStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    await sessionStore.commitFiles({
      files: {
        [gitMemorySessionStoreSummaryMarkdownPath(session.sessionId)]: "Summary text survives bad metadata.\n",
        [gitMemorySessionStoreSummaryMetaPath(session.sessionId)]: "{not-json",
      },
      message: "test: add session summary with invalid metadata",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.session.summary).toEqual({
      text: "Summary text survives bad metadata.",
    });
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

  it("can build session conversation context from markdown alone", async () => {
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
    const snapshot = await store.commitSessionStoreSnapshot({
      sessionId: session.sessionId,
      at: "2026-06-28T09:09:00+05:30",
      summary: "Snapshot upload handling conversation.",
    });
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
      sessionStoreCommit: snapshot.sessionStoreCommit,
      summary: "Inspected upload handling and found validation mismatch.",
      actions: [{
        actionId: "ACT-20260628-000001",
        tool: "read_files",
        status: "completed",
        summary: "Read upload server implementation.",
      }],
      evidence: [{
        step: 1,
        actionId: "ACT-20260628-000001",
        tool: "read_files",
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
            tool: "read_files",
            callId: "call-read-upload",
            filePath: "ayati-main/src/server/upload-server.ts",
            rawOutputPath: "raw/001-call-read-upload-read_files.txt",
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
      { seq: 1, type: "session_initialized" },
      { seq: 2, type: "task_created" },
      { seq: 3, type: "run_completed" },
    ]);
    expect(pack.session.recentCommits[0]).toMatchObject({
      subject: "ayati: initialize session S-20260628-local",
      event: "session_initialized",
    });
    expect(pack.session.recentCommits[0]).not.toHaveProperty("trailers");
    expect(pack.session.recentCommits[0]).not.toHaveProperty("conversationSeq");
    expect(pack.session.recentCommits[0]).not.toHaveProperty("schemaVersion");
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
      next: "Patch upload validation handling.",
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
    });
    expect(pack.task.facts).toEqual(expect.arrayContaining([
      "UploadServer validates multipart uploads.",
    ]));
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
      tool: "read_files",
      summary: "Read upload server implementation.",
      evidenceRef: "evidence/ACT-20260628-000001.txt",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: ["Upload server implementation was inspected."],
      outputSize: 1200,
      lineCount: 80,
      truncated: false,
      source: {
        kind: "git-memory-step",
        step: 1,
      },
    }]);
    expect(pack.task?.recentCommits[0]).toMatchObject({
      subject: "ayati: complete run R-20260628-0001",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      event: "run_completed",
    });
    expect(pack.task?.recentCommits[0]).not.toHaveProperty("trailers");
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

  it("reads active task conversation from task-local message files before aggregate markdown", async () => {
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
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.commitSyntheticFiles({
      ref: task.ref,
      files: {
        [gitMemoryTaskConversationMessagePath(task.taskId, 2, "assistant")]: [
          "# Message 000002",
          "",
          "Role: Assistant",
          "At: 2026-06-28T09:00:05+05:30",
          "Session: S-20260628-local",
          "Task: W-20260628-0001",
          "",
          "Task-local assistant copy.",
          "",
        ].join("\n"),
      },
      message: "override task-local conversation message",
    });

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
      limits: { conversationMarkdownCharLimit: 2_000 },
    });

    expect(pack.task?.conversationMarkdownTail).toContain("Task-local assistant copy.");
    expect(pack.task?.conversationMarkdownTail).not.toContain("I will inspect upload handling.");
  });

  it("prefers the active-task custom ref over the current task branch", async () => {
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
      taskId: reminderTask.taskId,
      branch: reminderTask.branch,
      ref: reminderTask.ref,
    });
    expect(pack.task).toMatchObject({
      taskId: reminderTask.taskId,
      title: "Fix reminder scheduling",
      summary: "Investigate reminder scheduling drift.",
      next: "Investigate reminder scheduling drift.",
    });
    expect(pack.task?.taskId).not.toBe(uploadTask.taskId);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 10)).toEqual(mainLogBefore);
    expect(await driver.log(uploadTask.ref, 10)).toEqual(uploadLogBefore);
    expect(await driver.log(reminderTask.ref, 10)).toEqual(reminderLogBefore);
  });

  it("uses the session active-task custom ref when HEAD is on main", async () => {
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
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
      summary: "Inspected upload handling.",
      state: {
        status: "in_progress",
        summary: "Inspected upload handling.",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        next: "Patch upload validation handling.",
      },
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await execFileAsync("git", ["-C", session.repoPath, "symbolic-ref", "HEAD", GIT_MEMORY_MAIN_REF]);

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(await driver.currentBranch()).toBe("main");
    expect(pack.focus).toMatchObject({
      status: "active",
      taskId: task.taskId,
      branch: task.branch,
      ref: task.ref,
    });
    expect(pack.task).toMatchObject({
      taskId: task.taskId,
      title: "Fix upload handling",
      summary: "Inspected upload handling.",
      next: "Patch upload validation handling.",
    });
  });

  it("falls back to the current branch when the active-task custom ref is stale", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-context-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const firstUser = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const firstTask = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: firstUser.seq,
      toSeq: firstUser.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    const secondUser = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix reminder scheduling",
      at: "2026-06-28T10:00:00+05:30",
    });
    const secondTask = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix reminder scheduling",
      objective: "Investigate reminder scheduling drift.",
      fromSeq: secondUser.seq,
      toSeq: secondUser.seq,
      at: "2026-06-28T10:01:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const mainCommit = await driver.resolveRef(GIT_MEMORY_MAIN_REF);
    if (!mainCommit) {
      throw new Error("Expected main ref.");
    }
    await driver.updateRef(gitMemorySessionActiveTaskRef(session.sessionId), mainCommit);
    await execFileAsync("git", ["-C", session.repoPath, "symbolic-ref", "HEAD", firstTask.ref]);

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });

    expect(pack.focus).toMatchObject({
      status: "active",
      taskId: firstTask.taskId,
      branch: firstTask.branch,
      ref: firstTask.ref,
    });
    expect(pack.task?.taskId).toBe(firstTask.taskId);
    expect(pack.task?.taskId).not.toBe(secondTask.taskId);
  });
});
