import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
  GitMemoryWorktreeGitDriver,
  GitMemoryDailySessionStore,
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
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_PATH)).toBe("");
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH)).toBe("");

    const events = parseJsonl(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_EVENTS_PATH));
    expect(events).toEqual([{
      v: 1,
      seq: 1,
      eventId: "E-20260628-000001",
      type: "session_initialized",
      at: "2026-06-28T00:00:00+05:30",
    }]);
    expect(JSON.parse(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_FOCUS_PATH) ?? "{}"))
      .toMatchObject({ activeTaskId: null, activeBranch: null, reason: "session_initialized" });
    expect(JSON.parse(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_TASKS_PATH) ?? "{}"))
      .toEqual({ schemaVersion: 1, tasks: [] });
    expect(JSON.parse(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_SCHEMA_PATH) ?? "{}"))
      .toMatchObject({ schemaVersion: 1, kind: "git_memory_session" });
  });

  it("appends conversation to the worktree without creating per-message commits", async () => {
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
      turnId: user.turnId,
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      at: "2026-06-28T09:00:05+05:30",
    });

    expect(user).toMatchObject({
      seq: 1,
      messageId: "M-20260628-000001",
      turnId: "T-20260628-000001",
      role: "user",
    });
    expect(assistant).toMatchObject({
      seq: 2,
      messageId: "M-20260628-000002",
      turnId: user.turnId,
      role: "assistant",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_PATH)).toBe("");
    expect(parseJsonl(await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_PATH))).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect the upload path." },
    ]);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
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

    const checkpoint = await store.checkpointSession({
      sessionId: session.sessionId,
      summary: "Checkpoint conversation after the first user turn.",
      at: "2026-06-28T09:01:00+05:30",
    });

    expect(checkpoint.event).toMatchObject({
      seq: 2,
      eventId: "E-20260628-000002",
      type: "session_checkpointed",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    const log = await driver.log(GIT_MEMORY_MAIN_REF, 5);
    expect(log).toHaveLength(2);
    expect(log[0]?.commit).toBe(checkpoint.commit);
    expect(parseGitMemoryCommitTrailers(log[0]?.message ?? "")).toMatchObject({
      sessionId: "S-20260628-local",
      event: "session_checkpointed",
      at: "2026-06-28T09:01:00+05:30",
    });
    expect(parseJsonl(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_PATH)))
      .toMatchObject([{ seq: 1, role: "user", text: "Keep this session change until checkpoint." }]);
    expect(parseJsonl(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_EVENTS_PATH)))
      .toMatchObject([
        { seq: 1, type: "session_initialized" },
        { seq: 2, type: "session_checkpointed" },
      ]);
  });

  it("links task conversation ranges without copying conversation records", async () => {
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
      text: "I will inspect the upload path.",
      turnId: user.turnId,
      at: "2026-06-28T09:00:05+05:30",
    });
    await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Also check image uploads later.",
      at: "2026-06-28T09:05:00+05:30",
    });

    const link = await store.linkTaskMessages({
      sessionId: session.sessionId,
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      reason: "task_created",
      fromSeq: 1,
      toSeq: 2,
      runId: "R-20260628-0001",
      summary: "Initial upload handling task conversation.",
      at: "2026-06-28T09:01:00+05:30",
    });

    expect(link).toMatchObject({
      v: 1,
      linkId: "L-20260628-000001",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      reason: "task_created",
      fromSeq: 1,
      toSeq: 2,
      turnIds: [user.turnId],
      runId: "R-20260628-0001",
    });

    const segments = await store.readTaskConversationSegments(session.sessionId, "W-20260628-0001");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.link).toMatchObject({ linkId: "L-20260628-000001" });
    expect(segments[0]?.messages).toMatchObject([
      { seq: 1, role: "user", text: "Fix upload handling" },
      { seq: 2, role: "assistant", text: "I will inspect the upload path." },
    ]);

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(parseJsonl(await driver.readWorkingFile(GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH)))
      .toMatchObject([{ linkId: "L-20260628-000001", fromSeq: 1, toSeq: 2 }]);
    expect(await driver.log(GIT_MEMORY_MAIN_REF, 5)).toHaveLength(1);
  });

  it("checkpoints task-message links with the session checkpoint", async () => {
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
      text: "Continue upload handling.",
      at: "2026-06-28T10:00:00+05:30",
    });
    await store.linkTaskMessages({
      sessionId: session.sessionId,
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      reason: "task_continued",
      fromSeq: 1,
      toSeq: 1,
      at: "2026-06-28T10:00:10+05:30",
    });

    await store.checkpointSession({
      sessionId: session.sessionId,
      summary: "Checkpoint task-message link.",
      at: "2026-06-28T10:01:00+05:30",
    });

    const driver = new GitMemoryWorktreeGitDriver(session.repoPath);
    expect(parseJsonl(await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH)))
      .toMatchObject([{
        linkId: "L-20260628-000001",
        taskId: "W-20260628-0001",
        reason: "task_continued",
        fromSeq: 1,
        toSeq: 1,
      }]);
  });
});

function parseJsonl(value: string | null): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}
