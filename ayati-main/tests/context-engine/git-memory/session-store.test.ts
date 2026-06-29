import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GitMemoryWorktreeGitDriver,
  GitMemoryDailySessionStore,
  gitMemoryTaskActionsPath,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskEvidenceManifestPath,
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStatePath,
  parseGitMemoryCommitTrailers,
} from "../../../src/context-engine/git-memory/index.js";

describe("GitMemoryDailySessionStore", () => {
  it("creates one daily repo with base files and one initialization commit", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });

    const first = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const second = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    expect(first).toMatchObject({
      sessionId: "S-20260628-local",
      initialized: true,
    });
    expect(first.repoPath.endsWith(".git")).toBe(false);
    expect(first.initialCommit).toBeTruthy();
    expect(second).toMatchObject({
      sessionId: "S-20260628-local",
      repoPath: first.repoPath,
      initialized: false,
    });

    const driver = new GitMemoryWorktreeGitDriver(first.repoPath);
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(log).toHaveLength(1);
    expect(log[0]?.message).toContain("ayati: initialize session S-20260628-local");
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      event: "session_initialized",
      schemaVersion: 1,
    });

    const meta = await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_META_PATH);
    expect(JSON.parse(meta ?? "{}")).toMatchObject({
      schemaVersion: 1,
      sessionId: "S-20260628-local",
      date: "2026-06-28",
      repoKind: "daily_session",
      agentId: "local",
    });
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/conversation.jsonl")).toBeNull();
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH))
      .toBe("# Conversation\n");
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/tasks.json")).toBeNull();
    expect(JSON.parse(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_SCHEMA_PATH) ?? "{}"))
      .toMatchObject({ schemaVersion: 1, kind: "git_memory_session" });
  });

  it("commits conversation appends to main without moving the active branch", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
    const assistant = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "assistant",
      text: "I will inspect the upload path.",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      at: "2026-06-28T09:00:05+05:30",
    });

    expect(user).toMatchObject({
      seq: 1,
      role: "user",
    });
    expect(assistant).toMatchObject({
      seq: 2,
      role: "assistant",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH))
      .toContain("I will inspect the upload path.");
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
    expect(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBe([
      "# Conversation",
      "",
      "## 2026-06-28T09:00:00+05:30 User",
      "",
      "Fix upload handling",
      "",
      "## 2026-06-28T09:00:05+05:30 Assistant",
      "",
      "Task: W-20260628-0001",
      "Run: R-20260628-0001",
      "",
      "I will inspect the upload path.",
      "",
    ].join("\n"));
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(log).toHaveLength(3);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      event: "conversation_appended",
      conversationSeq: { fromSeq: 2, toSeq: 2 },
    });
  });

  it("allocates conversation sequence from markdown without a debug jsonl file", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();

    const followUp = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "continue the upload work",
      at: "2026-06-28T09:01:00+05:30",
    });

    expect(followUp.seq).toBe(3);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
  });

  it("persists prebuilt main conversation records without allocating identity", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const record = {
      seq: 1,
      role: "assistant" as const,
      at: "2026-06-28T09:00:00+05:30",
      text: "I will inspect upload handling.",
    };

    const persisted = await store.appendMainConversationRecord({
      sessionId: session.sessionId,
      record,
    });

    expect(persisted).toEqual(record);
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH))
      .toContain("I will inspect upload handling.");
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      event: "conversation_appended",
      at: "2026-06-28T09:00:00+05:30",
      conversationSeq: { fromSeq: 1, toSeq: 1 },
    });
  });

  it("checkpoints accumulated session changes with a parseable commit", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
      text: "Keep this session change until checkpoint.",
      at: "2026-06-28T09:00:00+05:30",
    });

    await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Keep checkpoint metadata",
      objective: "Create session metadata that checkpoint can commit.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:00:30+05:30",
    });
    const checkpoint = await store.checkpointSession({
      sessionId: session.sessionId,
      summary: "Checkpoint task metadata after the first user turn.",
      at: "2026-06-28T09:01:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(log).toHaveLength(2);
    expect(log[0]?.commit).toBe(checkpoint.commit);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      event: "conversation_appended",
      conversationSeq: { fromSeq: 1, toSeq: 1 },
    });
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH))
      .toContain("Keep this session change until checkpoint.");
  });

  it("records the checked out branch in the conversation markdown", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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

    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "assistant",
      taskId: task.taskId,
      text: "I will inspect upload handling on the task branch.",
      at: "2026-06-28T09:02:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toContain(
      "Branch: task/W-20260628-0001-fix-upload-handling",
    );
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
    expect(await driver.currentBranch()).toBe("task/W-20260628-0001-fix-upload-handling");
  });

  it("creates task branches without copying session conversation into the task branch", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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

    expect(task).toMatchObject({
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      ref: "refs/heads/task/W-20260628-0001-fix-upload-handling",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(task.ref, "session/conversation.jsonl")).toBeNull();
    expect(await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBe([
      "# Conversation",
      "",
      "## 2026-06-28T09:00:00+05:30 User",
      "",
      "Task: W-20260628-0001",
      "",
      "Fix upload handling",
      "",
      "## 2026-06-28T09:00:05+05:30 Assistant",
      "",
      "Task: W-20260628-0001",
      "",
      "I will inspect upload handling.",
      "",
    ].join("\n"));
    expect(await driver.readFile(task.ref, `tasks/${task.taskId}/task.json`)).toBeNull();
    const taskMarkdown = await driver.readFile(task.ref, gitMemoryTaskMarkdownPath(task.taskId)) ?? "";
    expect(taskMarkdown).toContain("# Fix upload handling");
    expect(taskMarkdown).toContain("Task: W-20260628-0001");
    expect(taskMarkdown).toContain("Status: open");
    expect(taskMarkdown).toContain("## Objective");
    expect(taskMarkdown).toContain("Find and fix upload handling failures.");
    expect(taskMarkdown).not.toContain("## Open");
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskStatePath(task.taskId)) ?? "{}"))
      .toMatchObject({
        status: "open",
        summary: "Find and fix upload handling failures.",
        open: ["Find and fix upload handling failures."],
      });
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskAssetsPath(task.taskId)) ?? "{}"))
      .toEqual({ schemaVersion: 1, assets: [] });
    expect(await driver.readFile(task.ref, `tasks/${task.taskId}/assets.jsonl`)).toBeNull();

    const taskLog = await driver.log(task.ref, 3);
    expect(taskLog).toHaveLength(1);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      event: "task_created",
      branch: "task/W-20260628-0001-fix-upload-handling",
      conversationSeq: { fromSeq: 1, toSeq: 2 },
    });

    expect(await driver.readWorkingFile("session/tasks.json")).toBeNull();
    expect(await driver.currentBranch()).toBe("task/W-20260628-0001-fix-upload-handling");
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
  });

  it("creates task branch conversation ranges from markdown without a debug jsonl file", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();

    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 2,
      at: "2026-06-28T09:01:00+05:30",
    });

    const markdown = await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH) ?? "";
    expect(markdown).toContain("Fix upload handling");
    expect(markdown).toContain("I will inspect upload handling.");
  });

  it("appends task run conversation ranges to task branch markdown without duplicating existing blocks", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
      runId: "R-20260628-0001",
      at: "2026-06-28T09:01:00+05:30",
    });

    await store.startTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0001",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:01:30+05:30",
    });
    const followUp = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "finish it",
      at: "2026-06-28T09:05:00+05:30",
    });
    const appended = await store.appendTaskConversationRange({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0002",
      fromSeq: followUp.seq,
      toSeq: followUp.seq,
      at: "2026-06-28T09:05:00+05:30",
      reason: "task_routed",
    });
    await store.startTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0002",
      fromSeq: followUp.seq,
      toSeq: followUp.seq,
      at: "2026-06-28T09:05:01+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const markdown = await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH) ?? "";
    expect(markdown.match(/Fix upload handling/g)).toHaveLength(1);
    expect(markdown).toContain("Run: R-20260628-0001");
    expect(markdown).toContain("finish it");
    expect(markdown).toContain("Run: R-20260628-0002");
    expect(await driver.log(task.ref, 5)).toHaveLength(2);
    const taskLog = await driver.log(task.ref, 5);
    expect(taskLog[0]?.commit).toBe(appended.taskCommit);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "conversation_appended",
      conversationSeq: { fromSeq: followUp.seq, toSeq: followUp.seq },
    });
  });

  it("checkpoints session task index after task creation", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:01:00+05:30",
    });

    await store.checkpointSession({
      sessionId: session.sessionId,
      summary: "Checkpoint task creation metadata.",
      at: "2026-06-28T09:02:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/tasks.json")).toBeNull();
    expect(await driver.currentBranch()).toBe(task.branch);
  });

  it("commits task runs to the task branch and records session run metadata in the worktree", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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

    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
      summary: "Inspected upload handling and found validation mismatch.",
      assistantResponse: "I found the upload validation issue.",
      actions: [{
        actionId: "ACT-20260628-000001",
        tool: "read_file",
        status: "completed",
        summary: "Read upload server implementation.",
        startedAt: "2026-06-28T09:02:00+05:30",
        completedAt: "2026-06-28T09:02:01+05:30",
        evidenceRef: "evidence/ACT-20260628-000001.txt",
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
        accessModes: ["summary", "read_lines"],
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
      changedFiles: ["ayati-main/src/server/upload-server.ts"],
      newFacts: ["UploadServer validates multipart uploads."],
      next: "Patch upload validation handling.",
      state: {
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling"],
        next: "Patch upload validation handling.",
      },
    });

    expect(run).toMatchObject({
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      ref: task.ref,
      runId: "R-20260628-0001",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskStatePath(task.taskId)) ?? "{}"))
      .toMatchObject({
        status: "in_progress",
        summary: "Inspected upload handling and found validation mismatch.",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling"],
        facts: ["UploadServer validates multipart uploads."],
        next: "Patch upload validation handling.",
      });
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskRunPath(task.taskId, run.runId)) ?? "{}"))
      .toMatchObject({
        runId: "R-20260628-0001",
        taskId: "W-20260628-0001",
        status: "completed",
        conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
        summary: "Inspected upload handling and found validation mismatch.",
        toolCallCount: 1,
        changedFiles: ["ayati-main/src/server/upload-server.ts"],
        newFacts: ["UploadServer validates multipart uploads."],
      });
    const runMarkdown = await driver.readFile(task.ref, gitMemoryTaskRunMarkdownPath(task.taskId, run.runId)) ?? "";
    expect(runMarkdown).toContain("# Run R-20260628-0001");
    expect(runMarkdown).toContain("Task: W-20260628-0001");
    expect(runMarkdown).toContain("Status: completed");
    expect(runMarkdown).toContain("## Summary");
    expect(runMarkdown).toContain("Inspected upload handling and found validation mismatch.");
    expect(runMarkdown).toContain("- ayati-main/src/server/upload-server.ts");
    expect(runMarkdown).toContain("- UploadServer validates multipart uploads.");
    expect(runMarkdown).toContain("- ACT-20260628-000001 read_file completed: Read upload server implementation.");
    expect(runMarkdown).toContain("Evidence: evidence/ACT-20260628-000001.txt");
    expect(parseJsonl(await driver.readFile(task.ref, gitMemoryTaskActionsPath(task.taskId, run.runId))))
      .toMatchObject([{
        actionId: "ACT-20260628-000001",
        runId: "R-20260628-0001",
        tool: "read_file",
        status: "completed",
      }]);
    expect(parseJsonl(await driver.readFile(task.ref, gitMemoryTaskEvidenceManifestPath(task.taskId, run.runId))))
      .toMatchObject([{
        actionId: "ACT-20260628-000001",
        runId: "R-20260628-0001",
        taskId: "W-20260628-0001",
        tool: "read_file",
        status: "completed",
        summary: "Read upload server implementation.",
        evidenceRef: "evidence/ACT-20260628-000001.txt",
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload server implementation was inspected."],
        accessModes: ["summary", "read_lines"],
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
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskAssetsPath(task.taskId)) ?? "{}"))
      .toEqual({
        schemaVersion: 1,
        assets: [{
          assetId: "asset-upload-log",
          role: "reference",
          kind: "file",
          name: "upload.log",
          path: "/tmp/upload.log",
        }],
      });
    await expect(store.readTaskDetail({
      sessionId: session.sessionId,
      taskId: task.taskId,
      include: ["evidence", "markdown"],
      limits: {
        evidenceLimit: 1,
        runLimit: 1,
        taskMarkdownCharLimit: 2_000,
        runMarkdownCharLimit: 2_000,
      },
    })).resolves.toMatchObject({
      taskMarkdown: expect.stringContaining("# Fix upload handling"),
      recentRunMarkdown: [{
        runId: "R-20260628-0001",
        path: "tasks/W-20260628-0001/runs/R-20260628-0001.md",
        markdown: expect.stringContaining("Inspected upload handling and found validation mismatch."),
      }],
      recentEvidence: [{
        runId: "R-20260628-0001",
        taskId: "W-20260628-0001",
        evidenceRef: "evidence/ACT-20260628-000001.txt",
      }],
    });

    const taskLog = await driver.log(task.ref, 5);
    expect(taskLog).toHaveLength(2);
    expect(taskLog[0]?.commit).toBe(run.taskCommit);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      event: "run_completed",
      status: "completed",
      conversationSeq: { fromSeq: 1, toSeq: 2 },
    });
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "").raw["Ayati-Action-Id"])
      .toEqual(["ACT-20260628-000001"]);

    expect(await driver.readWorkingFile("session/tasks.json")).toBeNull();
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(3);
  });

  it("rejects duplicate task run commits for the same run id", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:01:00+05:30",
    });

    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0007",
      status: "completed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Finished the first upload run.",
      state: {
        status: "in_progress",
        completed: ["Finished the first upload run"],
        open: ["Continue upload validation"],
        next: "Continue upload validation.",
      },
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const logAfterFirstCommit = await driver.log(task.ref, 5);

    await expect(store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0007",
      status: "failed",
      completedAt: "2026-06-28T09:12:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Tried to commit the same run again.",
      state: {
        status: "blocked",
        completed: ["Finished the first upload run"],
        open: ["Resolve duplicate run"],
        blockers: ["Duplicate run id."],
        next: "Resolve duplicate run.",
      },
    })).rejects.toThrow("Git memory task run already committed: R-20260628-0007");

    expect(await driver.log(task.ref, 5)).toEqual(logAfterFirstCommit);
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskRunPath(task.taskId, "R-20260628-0007")) ?? "{}"))
      .toMatchObject({
        runId: "R-20260628-0007",
        status: "completed",
        summary: "Finished the first upload run.",
      });
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskStatePath(task.taskId)) ?? "{}"))
      .toMatchObject({
        status: "in_progress",
        next: "Continue upload validation.",
      });
  });

  it("checkpoints session metadata after a task run commit", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:01:00+05:30",
    });
    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Finished the first upload run.",
      state: {
        status: "done",
        completed: ["Finished the first upload run"],
        open: [],
        next: "No next step.",
      },
    });

    await store.checkpointSession({
      sessionId: session.sessionId,
      summary: "Checkpoint task run metadata.",
      at: "2026-06-28T09:11:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/tasks.json")).toBeNull();
  });
});

function parseJsonl(value: string | null): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}
