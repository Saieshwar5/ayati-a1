import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  GitMemoryContextReader,
  GitMemoryWorktreeGitDriver,
  GitMemoryDailySessionStore,
  gitMemorySessionStoreMessagePath,
  gitMemorySessionStoreMessagesDir,
  gitMemorySessionStoreAttachmentsPath,
  gitMemorySessionStoreMetaPath,
  gitMemorySessionStoreSchemaPath,
  gitMemorySessionStoreSummaryMarkdownPath,
  gitMemorySessionStoreSummaryMetaPath,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskConversationMessagePath,
  gitMemoryTaskDir,
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStepsPath,
  gitMemoryTaskStatePath,
  parseGitMemoryCommitTrailers,
} from "../../../src/context-engine/git-memory/index.js";

const execFileAsync = promisify(execFile);

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

    expect(await driver.listTreePaths(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_STORE_DIR))
      .toEqual([GIT_MEMORY_SESSION_STORE_DIR]);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/meta.json")).toBeNull();
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/schema.json")).toBeNull();
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/conversation.md")).toBeNull();
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const meta = await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreMetaPath(first.sessionId),
    );
    expect(JSON.parse(meta ?? "{}")).toMatchObject({
      schemaVersion: 1,
      sessionId: "S-20260628-local",
      date: "2026-06-28",
      repoKind: "daily_session",
      agentId: "local",
    });
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, "session/tasks.json")).toBeNull();
    expect(JSON.parse(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSchemaPath(first.sessionId),
    ) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      kind: "git_memory_session",
      sourceOfTruth: "session_store",
      commitPolicy: "task_run_snapshot",
    });
  });

  it("writes session summary files into the session-store submodule without changing parent conversation files", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const parentMainBefore = await driver.resolveRef(GIT_MEMORY_MAIN_REF);
    const parentConversationBefore = await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH);

    const result = await store.writeSessionSummary({
      sessionId: session.sessionId,
      text: "The session is cleaning prompt context before adding automatic summary updates.",
      updatedAt: "2026-06-28T09:30:00+05:30",
      strategy: "deterministic",
      coveredUntilSeq: 12,
      messageCount: 8,
      sourceFromSeq: 5,
      sourceToSeq: 12,
      previousCoveredUntilSeq: 4,
    });

    expect(result.metadata).toEqual({
      schemaVersion: 1,
      formatVersion: 1,
      sessionId: session.sessionId,
      updatedAt: "2026-06-28T09:30:00+05:30",
      strategy: "deterministic",
      coveredUntilSeq: 12,
      messageCount: 8,
      sourceFromSeq: 5,
      sourceToSeq: 12,
      previousCoveredUntilSeq: 4,
    });
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.resolveRef(GIT_MEMORY_MAIN_REF)).toBe(result.sessionStoreCommit);
    expect(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMarkdownPath(session.sessionId),
    )).toBe("The session is cleaning prompt context before adding automatic summary updates.\n");
    expect(JSON.parse(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMetaPath(session.sessionId),
    ) ?? "{}")).toEqual(result.metadata);
    expect(await messageStore.listTreePaths(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreMessagesDir(session.sessionId),
    )).toEqual([]);
    expect(await driver.resolveRef(GIT_MEMORY_MAIN_REF)).toBe(parentMainBefore);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH))
      .toBe(parentConversationBefore);

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });
    expect(pack.session.summary).toEqual({
      text: "The session is cleaning prompt context before adding automatic summary updates.",
      updatedAt: "2026-06-28T09:30:00+05:30",
      coveredUntilSeq: 12,
    });
  });

  it("updates existing session summary files without creating conversation messages", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    const first = await store.writeSessionSummary({
      sessionId: session.sessionId,
      text: "First summary.",
      updatedAt: "2026-06-28T09:30:00+05:30",
      coveredUntilSeq: 4,
      messageCount: 2,
    });
    const second = await store.writeSessionSummary({
      sessionId: session.sessionId,
      text: "Updated summary.",
      updatedAt: "2026-06-28T10:00:00+05:30",
      coveredUntilSeq: 8,
      messageCount: 5,
    });

    expect(second.sessionStoreCommit).not.toBe(first.sessionStoreCommit);
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMarkdownPath(session.sessionId),
    )).toBe("Updated summary.\n");
    expect(JSON.parse(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreSummaryMetaPath(session.sessionId),
    ) ?? "{}")).toEqual(second.metadata);
    expect(await messageStore.listTreePaths(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreMessagesDir(session.sessionId),
    )).toEqual([]);

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });
    expect(pack.session.summary).toEqual({
      text: "Updated summary.",
      updatedAt: "2026-06-28T10:00:00+05:30",
      coveredUntilSeq: 8,
    });
  });

  it("writes session attachment metadata into the session-store working tree without parent commits", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const parentMainBefore = await driver.resolveRef(GIT_MEMORY_MAIN_REF);
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const sessionStoreMainBefore = await messageStore.resolveRef(GIT_MEMORY_MAIN_REF);

    const file = await store.upsertSessionAttachments({
      sessionId: session.sessionId,
      updatedAt: "2026-06-28T09:30:00+05:30",
      attachments: [{
        sessionAssetId: "SA-test-policy",
        kind: "document",
        name: "policy.pdf",
        source: "cli",
        status: "ready",
        documentId: "doc-policy",
        originalPath: "/tmp/policy.pdf",
        storedPath: "documents/doc-policy/policy.pdf",
        sizeBytes: 1234,
        checksum: "abc123",
        createdAt: "2026-06-28T09:29:00+05:30",
        lastUsedAt: "2026-06-28T09:30:00+05:30",
      }],
    });

    expect(file).toEqual({
      schemaVersion: 1,
      sessionId: session.sessionId,
      updatedAt: "2026-06-28T09:30:00+05:30",
      attachments: [{
        sessionAssetId: "SA-test-policy",
        kind: "document",
        name: "policy.pdf",
        source: "cli",
        status: "ready",
        documentId: "doc-policy",
        originalPath: "/tmp/policy.pdf",
        storedPath: "documents/doc-policy/policy.pdf",
        sizeBytes: 1234,
        checksum: "abc123",
        createdAt: "2026-06-28T09:29:00+05:30",
        lastUsedAt: "2026-06-28T09:30:00+05:30",
      }],
    });
    expect(JSON.parse(await messageStore.readWorkingFile(
      gitMemorySessionStoreAttachmentsPath(session.sessionId),
    ) ?? "{}")).toEqual(file);
    expect(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreAttachmentsPath(session.sessionId),
    )).toBeNull();
    expect(await driver.resolveRef(GIT_MEMORY_MAIN_REF)).toBe(parentMainBefore);
    expect(await messageStore.resolveRef(GIT_MEMORY_MAIN_REF)).toBe(sessionStoreMainBefore);
    expect(await driver.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreAttachmentsPath(session.sessionId),
    )).toBeNull();

    const pack = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });
    expect(pack.session.attachments).toEqual({
      count: 1,
      updatedAt: "2026-06-28T09:30:00+05:30",
      recent: [{
        sessionAssetId: "SA-test-policy",
        kind: "document",
        name: "policy.pdf",
        source: "cli",
        status: "ready",
        documentId: "doc-policy",
        originalPath: "/tmp/policy.pdf",
        storedPath: "documents/doc-policy/policy.pdf",
        sizeBytes: 1234,
        createdAt: "2026-06-28T09:29:00+05:30",
        lastUsedAt: "2026-06-28T09:30:00+05:30",
      }],
    });
  });

  it("upserts session attachment metadata by session asset id", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    await store.upsertSessionAttachments({
      sessionId: session.sessionId,
      updatedAt: "2026-06-28T09:30:00+05:30",
      attachments: [{
        sessionAssetId: "SA-test-policy",
        kind: "document",
        name: "policy.pdf",
        source: "cli",
        status: "ready",
        createdAt: "2026-06-28T09:29:00+05:30",
      }],
    });
    const updated = await store.upsertSessionAttachments({
      sessionId: session.sessionId,
      updatedAt: "2026-06-28T09:45:00+05:30",
      attachments: [{
        sessionAssetId: "SA-test-policy",
        kind: "document",
        name: "renamed-policy.pdf",
        source: "cli",
        status: "partial",
        createdAt: "2026-06-28T09:40:00+05:30",
      }, {
        sessionAssetId: "SA-test-data",
        kind: "dataset",
        name: "data.csv",
        source: "upload",
        status: "ready",
        createdAt: "2026-06-28T09:44:00+05:30",
      }],
    });

    expect(updated.attachments).toEqual([{
      sessionAssetId: "SA-test-data",
      kind: "dataset",
      name: "data.csv",
      source: "upload",
      status: "ready",
      createdAt: "2026-06-28T09:44:00+05:30",
      lastUsedAt: "2026-06-28T09:45:00+05:30",
    }, {
      sessionAssetId: "SA-test-policy",
      kind: "document",
      name: "renamed-policy.pdf",
      source: "cli",
      status: "partial",
      createdAt: "2026-06-28T09:29:00+05:30",
      lastUsedAt: "2026-06-28T09:45:00+05:30",
    }]);
  });

  it("writes conversation appends to the session-store working tree without parent commits", async () => {
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
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    const messageStore = new GitMemoryWorktreeGitDriver(join(session.repoPath, GIT_MEMORY_SESSION_STORE_DIR));
    expect(await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, user.seq, user.role),
    )).toBe([
      "# Message 000001",
      "",
      "Role: User",
      "At: 2026-06-28T09:00:00+05:30",
      "Session: S-20260628-local",
      "",
      "Fix upload handling",
      "",
    ].join("\n"));
    expect(await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, assistant.seq, assistant.role),
    )).toBe([
      "# Message 000002",
      "",
      "Role: Assistant",
      "At: 2026-06-28T09:00:05+05:30",
      "Session: S-20260628-local",
      "Task: W-20260628-0001",
      "Run: R-20260628-0001",
      "",
      "I will inspect the upload path.",
      "",
    ].join("\n"));
    expect(await driver.listTreePaths(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_STORE_DIR))
      .toEqual([GIT_MEMORY_SESSION_STORE_DIR]);
    expect(await driver.readWorkingFile("session/conversation.jsonl")).toBeNull();
    expect(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(log).toHaveLength(1);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      event: "session_initialized",
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
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    const message = await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, record.seq, record.role),
    );
    expect(message).toContain(
      "Session: S-20260628-local",
    );
    expect(message).toContain(
      "I will inspect upload handling.",
    );
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      event: "session_initialized",
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
    expect(log).toHaveLength(1);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      event: "session_initialized",
    });
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.resolveRef(GIT_MEMORY_MAIN_REF)).toBe(checkpoint.commit);
    const messageStoreLog = await messageStore.log(GIT_MEMORY_MAIN_REF, 5);
    expect(parseGitMemoryCommitTrailers(messageStoreLog[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      event: "conversation_appended",
    });
    expect(await messageStore.readFile(
      GIT_MEMORY_MAIN_REF,
      gitMemorySessionStoreMessagePath(session.sessionId, 1, "user"),
    ))
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
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, 2, "assistant"),
    )).toContain(
      "Branch: task/W-20260628-0001-fix-upload-handling",
    );
    expect(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
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
    expect(await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    expect(await driver.readFile(task.ref, gitMemoryTaskConversationMessagePath(task.taskId, 1, "user"))).toBeNull();
    expect(await driver.readFile(task.ref, gitMemoryTaskConversationMessagePath(task.taskId, 2, "assistant"))).toBeNull();
    expect(await driver.readFile(task.ref, gitMemoryTaskConversationMessagePath(task.taskId, 3, "user"))).toBeNull();
    expect(await driver.listTreePaths(task.ref, gitMemoryTaskDir(task.taskId))).toEqual([
      gitMemoryTaskAssetsPath(task.taskId),
      gitMemoryTaskNotesPath(task.taskId),
      gitMemoryTaskStatePath(task.taskId),
      gitMemoryTaskMarkdownPath(task.taskId),
    ].sort());
    const taskMarkdown = await driver.readFile(task.ref, gitMemoryTaskMarkdownPath(task.taskId)) ?? "";
    expect(taskMarkdown).toContain("# Fix upload handling");
    expect(taskMarkdown).toContain("Task: W-20260628-0001");
    expect(taskMarkdown).toContain("Status: open");
    expect(taskMarkdown).toContain("## Objective");
    expect(taskMarkdown).toContain("Find and fix upload handling failures.");
    expect(taskMarkdown).not.toContain("## Open");
    const taskNotes = await driver.readFile(task.ref, gitMemoryTaskNotesPath(task.taskId)) ?? "";
    expect(taskNotes).toContain("# Fix upload handling");
    expect(taskNotes).toContain("Task: W-20260628-0001");
    expect(taskNotes).toContain("Branch: task/W-20260628-0001-fix-upload-handling");
    expect(taskNotes).toContain("Status: open");
    expect(taskNotes).toContain("Updated: 2026-06-28T09:01:00+05:30");
    expect(taskNotes).toContain("## Objective");
    expect(taskNotes).toContain("Find and fix upload handling failures.");
    expect(taskNotes).toContain("## Summary");
    expect(taskNotes).toContain("## Open Work");
    expect(taskNotes).toContain("- Find and fix upload handling failures.");
    expect(taskNotes).toContain("## Blockers\n\nNone.");
    expect(taskNotes).toContain("## Files\n\nNone.");
    expect(taskNotes).toContain("## Search Terms");
    expect(taskNotes).toContain("upload");
    expect(taskNotes).not.toContain("Latest Run:");
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskStatePath(task.taskId)) ?? "{}"))
      .toMatchObject({
        status: "open",
        summary: "Find and fix upload handling failures.",
        open: ["Find and fix upload handling failures."],
      });
    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskAssetsPath(task.taskId)) ?? "{}"))
      .toEqual({ schemaVersion: 1, assets: [] });
    expect(await driver.readFile(task.ref, `tasks/${task.taskId}/assets.jsonl`)).toBeNull();

    const taskLog = await driver.log(task.ref, 5);
    expect(taskLog[0]?.commit).toBe(task.taskCommit);
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      event: "task_created",
      branch: "task/W-20260628-0001-fix-upload-handling",
      conversationSeq: { fromSeq: 1, toSeq: 2 },
    });

    expect(await driver.readWorkingFile("session/tasks.json")).toBeNull();
    expect(await driver.currentBranch()).toBe("task/W-20260628-0001-fix-upload-handling");
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
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

    expect(await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
    expect(await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, 1, "user"),
    )).toContain("Fix upload handling");
    expect(await messageStore.readWorkingFile(
      gitMemorySessionStoreMessagePath(session.sessionId, 2, "assistant"),
    )).toContain("I will inspect upload handling.");
    expect(parseGitMemoryCommitTrailers((await driver.log(task.ref, 5))[0]?.message ?? ""))
      .toMatchObject({
        conversationSeq: { fromSeq: 1, toSeq: 2 },
      });
  });

  it("starts task runs without writing task-local conversation files", async () => {
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

    const started = await store.startTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0001",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:01:30+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(task.ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)).toBeNull();
    expect(await driver.readFile(
      task.ref,
      gitMemoryTaskConversationMessagePath(task.taskId, user.seq, user.role),
    )).toBeNull();
    const taskLog = await driver.log(task.ref, 5);
    expect(started).toEqual({ runId: "R-20260628-0001" });
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "task_created",
    });
    expect(await store.allocateTaskRunId(session.sessionId)).toBe("R-20260628-0002");
    await expect(store.startTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0001",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:01:45+05:30",
    })).rejects.toThrow("Git memory task run already reserved: R-20260628-0001");
  });

  it("does not start an already finalized task run", async () => {
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
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0001",
      status: "failed",
      completedAt: "2026-06-28T09:05:00+05:30",
      conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
      summary: "Provider failed before work completed.",
      toolCallCount: 0,
      changedFiles: [],
      state: {
        status: "blocked",
        summary: "Provider failed before work completed.",
        completed: [],
        open: ["Retry upload handling."],
        blockers: ["Unexpected end of JSON input"],
        next: "Retry upload handling.",
      },
    });

    await expect(store.startTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      branch: task.branch,
      runId: "R-20260628-0001",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:06:00+05:30",
    })).rejects.toThrow("Git memory task run already finalized: R-20260628-0001");
  });

  it("reads task detail conversation from task-local message files before aggregate markdown", async () => {
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
          "Task detail local copy.",
          "",
        ].join("\n"),
      },
      message: "override task-local detail conversation",
    });

    const detail = await store.readTaskDetail({
      sessionId: session.sessionId,
      taskId: task.taskId,
      include: ["conversation"],
      limits: { conversationMarkdownCharLimit: 2_000 },
    });

    expect(detail.conversationMarkdownTail).toContain("Task detail local copy.");
    expect(detail.conversationMarkdownTail).not.toContain("I will inspect upload handling.");
  });

  it("falls back to aggregate task conversation when task-local message files are missing", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-"));
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
      fromSeq: 99,
      toSeq: 99,
      at: "2026-06-28T09:01:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    await driver.commitSyntheticFiles({
      ref: task.ref,
      files: {
        [GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH]: [
          "# Conversation",
          "",
          "## 2026-06-28T09:00:00+05:30 User",
          "",
          "Task: W-20260628-0001",
          "",
          "Legacy aggregate task conversation.",
          "",
        ].join("\n"),
      },
      message: "add legacy aggregate task conversation",
    });

    const detail = await store.readTaskDetail({
      sessionId: session.sessionId,
      taskId: task.taskId,
      include: ["conversation"],
      limits: { conversationMarkdownCharLimit: 2_000 },
    });

    expect(detail.conversationMarkdownTail).toContain("Legacy aggregate task conversation.");
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
    await store.appendTaskRunStep({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0001",
      record: {
        v: 1,
        runId: "R-20260628-0001",
        taskId: task.taskId,
        step: 1,
        status: "completed",
        startedAt: "2026-06-28T09:02:00+05:30",
        completedAt: "2026-06-28T09:02:01+05:30",
        summary: "Read upload server implementation.",
        decision: {
          actionKind: "tool_calls",
          mode: "single",
        },
        action: {
          executionContract: "single action: read_file",
          toolsUsed: ["read_file"],
          toolSuccessCount: 1,
          toolFailureCount: 0,
        },
        toolCalls: [{
          callId: "call-read-upload",
          tool: "read_file",
          status: "success",
          input: {
            path: "ayati-main/src/server/upload-server.ts",
            range: [1, 80],
          },
          output: "full upload server implementation output\nline 2",
          rawOutputChars: 1200,
          outputTruncated: false,
          operationStatus: "completed",
          artifacts: [{
            kind: "file",
            path: "ayati-main/src/server/upload-server.ts",
          }],
          observation: {
            id: "obs-upload",
            step: 1,
            callId: "call-read-upload",
            tool: "read_file",
            status: "success",
            mode: "full",
            retention: "while_relevant",
            content: "full upload server implementation output\nline 2",
            evidenceRef: "evidence/ACT-20260628-000001.txt",
            rawOutputChars: 1200,
            lineCount: 80,
            hasMore: false,
          },
        }],
        verification: {
          passed: true,
          policy: "deterministic",
          method: "execution_gate",
          executionStatus: "all_succeeded",
          validationStatus: "passed",
          summary: "Read upload server implementation.",
          evidenceSummary: "evidence/ACT-20260628-000001.txt",
          evidenceItems: ["Upload server implementation was inspected."],
          newFacts: ["Upload server implementation was inspected."],
          artifacts: ["ayati-main/src/server/upload-server.ts"],
          usedRawArtifacts: [],
        },
        workStateAfter: {
          status: "not_done",
          summary: "Inspected upload handling.",
          verifiedFacts: ["Upload server implementation was inspected."],
          evidence: ["evidence/ACT-20260628-000001.txt"],
        },
        facts: ["Upload server implementation was inspected."],
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        outputSize: 1200,
        lineCount: 80,
        truncated: false,
      },
    });

    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0001",
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
      summary: "Inspected upload handling and found validation mismatch.",
      intent: "Fix upload handling failures.",
      routing: "conversation 1-2 routed to the upload handling task.",
      outcome: "Upload handling inspection completed.",
      workPerformed: ["Read upload server implementation."],
      verification: ["Confirmed upload validation mismatch from source inspection."],
      decisions: ["Patch validation handling in a later run."],
      blockers: ["Integration verification is still pending."],
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
        intent: "Fix upload handling failures.",
        routing: "conversation 1-2 routed to the upload handling task.",
        outcome: "Upload handling inspection completed.",
        workPerformed: ["Read upload server implementation."],
        verification: ["Confirmed upload validation mismatch from source inspection."],
        decisions: ["Patch validation handling in a later run."],
        blockers: ["Integration verification is still pending."],
        toolCallCount: 1,
        changedFiles: ["ayati-main/src/server/upload-server.ts"],
        newFacts: ["UploadServer validates multipart uploads."],
      });
    const runMarkdown = await driver.readFile(task.ref, gitMemoryTaskRunMarkdownPath(task.taskId, run.runId)) ?? "";
    expect(runMarkdown).toContain("# Run R-20260628-0001");
    expect(runMarkdown).toContain("Task: W-20260628-0001");
    expect(runMarkdown).toContain("Status: completed");
    expect(runMarkdown).toContain("## Intent");
    expect(runMarkdown).toContain("Fix upload handling failures.");
    expect(runMarkdown).toContain("## Routing");
    expect(runMarkdown).toContain("conversation 1-2 routed to the upload handling task.");
    expect(runMarkdown).toContain("## Outcome");
    expect(runMarkdown).toContain("Upload handling inspection completed.");
    expect(runMarkdown).toContain("## Work Performed");
    expect(runMarkdown).toContain("- Read upload server implementation.");
    expect(runMarkdown).toContain("## Verification");
    expect(runMarkdown).toContain("- Confirmed upload validation mismatch from source inspection.");
    expect(runMarkdown).toContain("## Decisions");
    expect(runMarkdown).toContain("- Patch validation handling in a later run.");
    expect(runMarkdown).toContain("## Blockers");
    expect(runMarkdown).toContain("- Integration verification is still pending.");
    expect(runMarkdown).toContain("## Next");
    expect(runMarkdown).toContain("Patch upload validation handling.");
    expect(runMarkdown).toContain("- ayati-main/src/server/upload-server.ts");
    expect(runMarkdown).toContain("- UploadServer validates multipart uploads.");
    expect(runMarkdown).toContain("- Step 1 completed: Read upload server implementation.");
    expect(runMarkdown).toContain("Tools: read_file");
    const taskNotes = await driver.readFile(task.ref, gitMemoryTaskNotesPath(task.taskId)) ?? "";
    expect(taskNotes).toContain("# Fix upload handling");
    expect(taskNotes).toContain("Task: W-20260628-0001");
    expect(taskNotes).toContain("Branch: task/W-20260628-0001-fix-upload-handling");
    expect(taskNotes).toContain("Status: in_progress");
    expect(taskNotes).toContain("Updated: 2026-06-28T09:10:00+05:30");
    expect(taskNotes).toContain("Latest Run: R-20260628-0001");
    expect(taskNotes).toContain("## Summary");
    expect(taskNotes).toContain("Inspected upload handling and found validation mismatch.");
    expect(taskNotes).toContain("## Completed");
    expect(taskNotes).toContain("- Inspected upload server");
    expect(taskNotes).toContain("## Open Work");
    expect(taskNotes).toContain("- Patch upload validation handling");
    expect(taskNotes).toContain("## Facts");
    expect(taskNotes).toContain("- UploadServer validates multipart uploads.");
    expect(taskNotes).toContain("## Decisions");
    expect(taskNotes).toContain("- Patch validation handling in a later run.");
    expect(taskNotes).toContain("## Files");
    expect(taskNotes).toContain("- ayati-main/src/server/upload-server.ts");
    expect(taskNotes).toContain("## Recent Work");
    expect(taskNotes).toContain("- Read upload server implementation.");
    expect(taskNotes).toContain("## Search Terms");
    expect(taskNotes).toContain("upload");
    expect(taskNotes).toContain("server");
    expect(taskNotes).toContain("## Next");
    expect(taskNotes).toContain("Patch upload validation handling.");
    expect(taskNotes).not.toContain("raw/001-call-read-upload-read_file.txt");
    expect(taskNotes).not.toContain("evidence/ACT-20260628-000001.txt");
    const steps = parseJsonl(await driver.readFile(task.ref, gitMemoryTaskStepsPath(task.taskId, run.runId)));
    expect(steps)
      .toMatchObject([{
        runId: "R-20260628-0001",
        status: "completed",
        taskId: "W-20260628-0001",
        step: 1,
        summary: "Read upload server implementation.",
        toolCalls: [{
          callId: "call-read-upload",
          tool: "read_file",
          input: {
            path: "ayati-main/src/server/upload-server.ts",
            range: [1, 80],
          },
          output: "full upload server implementation output\nline 2",
          observation: {
            content: "full upload server implementation output\nline 2",
            evidenceRef: "evidence/ACT-20260628-000001.txt",
          },
        }],
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload server implementation was inspected."],
        verification: {
          passed: true,
          evidenceSummary: "evidence/ACT-20260628-000001.txt",
          evidenceItems: ["Upload server implementation was inspected."],
        },
        outputSize: 1200,
        lineCount: 80,
        truncated: false,
      }]);
    expect(await driver.readFile(task.ref, `tasks/${task.taskId}/actions/${run.runId}.jsonl`)).toBeNull();
    expect(await driver.readFile(task.ref, `tasks/${task.taskId}/evidence/${run.runId}/manifest.jsonl`)).toBeNull();
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
        markdown: expect.stringContaining("Upload handling inspection completed."),
      }],
      recentEvidence: [{
        runId: "R-20260628-0001",
        taskId: "W-20260628-0001",
        evidenceRef: "evidence/ACT-20260628-000001.txt",
      }],
    });

    const taskLog = await driver.log(task.ref, 5);
    expect(taskLog[0]?.commit).toBe(run.taskCommit);
    expect(taskLog[0]?.message).toContain("Outcome:\nUpload handling inspection completed.");
    expect(taskLog[0]?.message).toContain("Work Performed:\n- Read upload server implementation.");
    expect(taskLog[0]?.message).toContain("Verification:\n- Confirmed upload validation mismatch from source inspection.");
    expect(taskLog[0]?.message).toContain("Next:\nPatch upload validation handling.");
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
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
  });

  it("materializes synthetic task commits into a clean parent worktree", async () => {
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
      text: "Create a Linux commands file.",
      at: "2026-06-28T09:00:00+05:30",
    });
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Linux commands file",
      objective: "Create a text file with ten Linux commands.",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T09:01:00+05:30",
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    expect(await driver.currentBranch()).toBe(task.branch);
    expect(await driver.readWorkingFile(gitMemoryTaskMarkdownPath(task.taskId)))
      .toContain("Linux commands file");
    expect(await driver.readWorkingFile(gitMemoryTaskStatePath(task.taskId)))
      .toContain("Create a text file with ten Linux commands.");

    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "assistant",
      text: "Created the Linux commands file.",
      taskId: task.taskId,
      runId: "R-20260628-0001",
      at: "2026-06-28T09:02:00+05:30",
    });
    const snapshot = await store.commitSessionStoreSnapshot({
      sessionId: session.sessionId,
      at: "2026-06-28T09:02:01+05:30",
      summary: "Snapshot conversation for task run R-20260628-0001.",
    });
    const run = await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      runId: "R-20260628-0001",
      status: "completed",
      completedAt: "2026-06-28T09:03:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
      summary: "Created the Linux commands file.",
      outcome: "Created the Linux commands file.",
      workPerformed: ["Wrote ten Linux commands to a text file."],
      verification: ["Confirmed the command file was written."],
      sessionStoreCommit: snapshot.sessionStoreCommit,
      state: {
        status: "done",
        completed: ["Wrote ten Linux commands to a text file."],
        open: [],
        next: "No next step.",
      },
    });
    const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);

    expect(run.sessionStoreCommit).toBe(snapshot.sessionStoreCommit);
    expect(await driver.readWorkingFile(gitMemoryTaskRunPath(task.taskId, run.runId)))
      .toContain(`"sessionStoreCommit": "${snapshot.sessionStoreCommit}"`);
    expect(await driver.readWorkingFile(gitMemoryTaskRunMarkdownPath(task.taskId, run.runId)))
      .toContain(`Session Store Commit: ${snapshot.sessionStoreCommit}`);
    expect(await gitStatus(session.repoPath)).toBe("");
    expect(await gitStatus(messageStore.repoPath)).toBe("");
  });

  it("renders failed task runs with clear default outcome memory", async () => {
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
      runId: "R-20260628-0002",
      status: "failed",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 1 }],
      summary: "Upload verification failed.",
      state: {
        status: "blocked",
        summary: "Upload verification failed.",
        completed: [],
        open: ["Retry upload verification"],
        blockers: ["Upload verification failed."],
        next: "Retry upload verification.",
      },
    });
    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);

    expect(JSON.parse(await driver.readFile(task.ref, gitMemoryTaskRunPath(task.taskId, run.runId)) ?? "{}"))
      .toMatchObject({
        runId: "R-20260628-0002",
        status: "failed",
        outcome: "Run failed: Upload verification failed.",
        blockers: ["Upload verification failed."],
      });
    const runMarkdown = await driver.readFile(task.ref, gitMemoryTaskRunMarkdownPath(task.taskId, run.runId)) ?? "";
    expect(runMarkdown).toContain("## Outcome");
    expect(runMarkdown).toContain("Run failed: Upload verification failed.");
    expect(runMarkdown).toContain("## Blockers");
    expect(runMarkdown).toContain("- Upload verification failed.");
    const taskNotes = await driver.readFile(task.ref, gitMemoryTaskNotesPath(task.taskId)) ?? "";
    expect(taskNotes).toContain("Status: blocked");
    expect(taskNotes).toContain("Latest Run: R-20260628-0002");
    expect(taskNotes).toContain("## Summary");
    expect(taskNotes).toContain("Upload verification failed.");
    expect(taskNotes).toContain("## Open Work");
    expect(taskNotes).toContain("- Retry upload verification");
    expect(taskNotes).toContain("## Blockers");
    expect(taskNotes).toContain("- Upload verification failed.");
    expect(taskNotes).toContain("Retry upload verification.");

    const taskLog = await driver.log(task.ref, 5);
    expect(taskLog[0]?.message).toContain("Outcome:\nRun failed: Upload verification failed.");
    expect(parseGitMemoryCommitTrailers(taskLog[0]?.message ?? "")).toMatchObject({
      event: "run_failed",
      status: "failed",
    });
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

async function gitStatus(repoPath: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", repoPath, "status", "--short"]);
  return result.stdout.trim();
}
