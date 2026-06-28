import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitDriver } from "../../../src/context-engine/daily-session/index.js";
import {
  GIT_MEMORY_MAIN_REF,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
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
    expect(first.initialCommit).toBeTruthy();
    expect(second).toMatchObject({
      sessionId: "S-20260628-local",
      repoPath: first.repoPath,
      initialized: false,
    });

    const driver = new GitDriver(first.repoPath);
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
});

function parseJsonl(value: string | null): unknown[] {
  if (!value?.trim()) {
    return [];
  }
  return value.trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
}
