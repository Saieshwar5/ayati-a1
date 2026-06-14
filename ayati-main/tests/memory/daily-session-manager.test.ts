import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionManagerOptions } from "../../src/memory/session-manager.js";
import type { SessionCloseData } from "../../src/memory/session-manager.js";

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ayati-daily-session-"));
  tempDirs.push(dir);
  return dir;
}

function manager(
  dataDir: string,
  now: () => Date,
  options?: Omit<SessionManagerOptions, "dataDir" | "now" | "sessionTimezone">,
): SessionManager {
  return new SessionManager({
    dataDir,
    now,
    sessionTimezone: "UTC",
    ...options,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daily session manager", () => {
  it("stores one date-partitioned daily session with user, assistant, and system events", async () => {
    let now = new Date("2026-06-12T09:00:00.000Z");
    const memory = manager(tempDataDir(), () => now);
    memory.initialize("local");

    const run = memory.beginRun("local", "hello");
    now = new Date("2026-06-12T09:00:01.000Z");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "hi", { responseKind: "reply" });
    const systemRun = memory.beginSystemRun("local", {
      source: "pulse",
      event: "reminder_due",
      eventId: "evt-1",
      summary: "Reminder due: standup",
    });

    await memory.flushPersistence();
    const ctx = memory.getPromptMemoryContext();

    expect(ctx.recentExchanges).toHaveLength(1);
    expect(ctx.recentExchanges[0]).toMatchObject({
      runId: run.runId,
      user: { content: "hello" },
      assistant: { content: "hi", responseKind: "reply" },
    });
    expect(ctx.recentSystemEvents).toHaveLength(1);
    expect(ctx.recentSystemEvents[0]).toMatchObject({
      source: "pulse",
      event: "reminder_due",
      eventId: "evt-1",
      summary: "Reminder due: standup",
    });
    expect(systemRun.sessionId).toBe(run.sessionId);
    expect(ctx.activeSessionPath).toMatch(/^sessions\/2026-06-12\/.+\.jsonl$/);

    const sessionFile = join(memoryDataDirFromContext(ctx.activeSessionPath), "");
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain("\"type\":\"user_message\"");
    expect(content).toContain("\"type\":\"assistant_response\"");
    expect(content).toContain("\"type\":\"system_event\"");
    expect(content).not.toContain("task_summary");
    expect(content).not.toContain("tool_call");
  });

  it("keeps only the last 5 hot exchanges and rebuilds them after restart", async () => {
    let now = new Date("2026-06-12T10:00:00.000Z");
    const dataDir = tempDataDir();
    const memory = manager(dataDir, () => now);
    memory.initialize("local");

    for (let index = 0; index < 7; index++) {
      now = new Date(`2026-06-12T10:00:0${index}.000Z`);
      const run = memory.beginRun("local", `user ${index}`);
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `assistant ${index}`, { responseKind: "reply" });
    }
    await memory.shutdown();

    const restored = manager(dataDir, () => new Date("2026-06-12T11:00:00.000Z"));
    restored.initialize("local");
    const ctx = restored.getPromptMemoryContext();

    expect(ctx.recentExchanges.map((exchange) => exchange.user.content)).toEqual([
      "user 2",
      "user 3",
      "user 4",
      "user 5",
      "user 6",
    ]);
    expect(ctx.recentExchanges.at(-1)?.assistant?.content).toBe("assistant 6");
    await restored.shutdown();
  });

  it("stores tool-using task summaries as session focus cards only", async () => {
    let now = new Date("2026-06-12T10:00:00.000Z");
    const dataDir = tempDataDir();
    const memory = manager(dataDir, () => now);
    memory.initialize("local");

    const run = memory.beginRun("local", "build the todo app");
    memory.queueTaskSummary("local", {
      runId: "no-tools",
      sessionId: run.sessionId,
      runPath: "data/runs/no-tools",
      status: "completed",
      objective: "Answer a simple question",
      summary: "Answered directly without tools.",
      toolsUsed: [],
    });
    now = new Date("2026-06-12T10:01:00.000Z");
    memory.queueTaskSummary("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/tool-run",
      status: "completed",
      taskStatus: "not_done",
      objective: "Build todo app",
      summary: "Created todo app shell in todo/index.html.",
      progressSummary: "Initial files are written.",
      openWork: ["make responsive"],
      keyFacts: ["todo/index.html exists"],
      evidence: ["write_files verified"],
      toolsUsed: ["write_files"],
    });

    const ctx = memory.getPromptMemoryContext();
    expect(ctx.sessionFocusCards).toHaveLength(1);
    expect(ctx.sessionFocusCards?.[0]).toMatchObject({
      scope: "session",
      sessionId: run.sessionId,
      label: "Build todo app",
      openWork: ["make responsive"],
    });
    expect(ctx.recentTaskSummaries).toEqual([]);

    await memory.flushPersistence();
    const sessionFile = join(memoryDataDirFromContext(ctx.activeSessionPath), "");
    const content = readFileSync(sessionFile, "utf8");
    expect(content).not.toContain("task_summary");
    await memory.shutdown();
  });

  it("creates a new session when the local date changes", async () => {
    let now = new Date("2026-06-12T23:59:00.000Z");
    const dataDir = tempDataDir();
    const memory = manager(dataDir, () => now);
    memory.initialize("local");

    const first = memory.beginRun("local", "before midnight");
    now = new Date("2026-06-13T00:01:00.000Z");
    const second = memory.beginRun("local", "after midnight");

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(memory.getPromptMemoryContext().activeSessionPath).toContain("sessions/2026-06-13/");
    await memory.shutdown();
  });

  it("closes the old session in the background with the full transcript when the date changes", async () => {
    let now = new Date("2026-06-12T23:50:00.000Z");
    const dataDir = tempDataDir();
    const closedSessions: SessionCloseData[] = [];
    const memory = manager(dataDir, () => now, {
      onSessionClose: (data) => {
        closedSessions.push(data);
      },
    });
    memory.initialize("local");

    let firstSessionId = "";
    for (let index = 0; index < 7; index++) {
      now = new Date(`2026-06-12T23:50:0${index}.000Z`);
      const run = memory.beginRun("local", `old user ${index}`);
      firstSessionId ||= run.sessionId;
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `old assistant ${index}`, {
        responseKind: "reply",
      });
    }

    now = new Date("2026-06-13T00:01:00.000Z");
    const next = memory.beginRun("local", "new day user");

    expect(next.sessionId).not.toBe(firstSessionId);
    expect(memory.getPromptMemoryContext().recentExchanges.map((exchange) => exchange.user.content)).toEqual([
      "new day user",
    ]);

    await memory.flushPersistence();
    await waitFor(() => closedSessions.length === 1);

    expect(closedSessions[0]?.sessionId).toBe(firstSessionId);
    expect(closedSessions[0]?.reason).toBe("daily_session_rotated");
    expect(closedSessions[0]?.turns.map((turn) => turn.content)).toEqual([
      "old user 0",
      "old assistant 0",
      "old user 1",
      "old assistant 1",
      "old user 2",
      "old assistant 2",
      "old user 3",
      "old assistant 3",
      "old user 4",
      "old assistant 4",
      "old user 5",
      "old assistant 5",
      "old user 6",
      "old assistant 6",
    ]);

    const db = new DatabaseSync(join(dataDir, "memory.sqlite"));
    try {
      const row = db.prepare("SELECT status, close_reason FROM sessions_meta WHERE session_id = ?")
        .get(firstSessionId) as Record<string, unknown>;
      expect(row["status"]).toBe("closed");
      expect(row["close_reason"]).toBe("daily_session_rotated");
    } finally {
      db.close();
    }
    await memory.shutdown();
  });

  it("does not block new session creation on a slow session-close callback", async () => {
    let now = new Date("2026-06-12T23:59:00.000Z");
    const dataDir = tempDataDir();
    let closeStarted = false;
    let closeFinished = false;
    let releaseClose!: () => void;
    const slowClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const memory = manager(dataDir, () => now, {
      onSessionClose: async () => {
        closeStarted = true;
        await slowClose;
        closeFinished = true;
      },
    });
    memory.initialize("local");

    const first = memory.beginRun("local", "before midnight");
    memory.recordAssistantFinal("local", first.runId, first.sessionId, "before reply", { responseKind: "reply" });
    now = new Date("2026-06-13T00:01:00.000Z");
    const second = memory.beginRun("local", "after midnight");

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(memory.getPromptMemoryContext().recentExchanges[0]?.user.content).toBe("after midnight");

    await memory.flushPersistence();
    await waitFor(() => closeStarted);
    expect(closeFinished).toBe(false);

    releaseClose();
    await memory.shutdown();
    expect(closeFinished).toBe(true);
  });

  it("keeps SQLite session metadata limited to daily-session lookup fields", async () => {
    const dataDir = tempDataDir();
    const memory = manager(dataDir, () => new Date("2026-06-12T09:00:00.000Z"));
    memory.initialize("local");
    memory.beginRun("local", "hello");
    await memory.shutdown();

    const db = new DatabaseSync(join(dataDir, "memory.sqlite"));
    try {
      const columns = db
        .prepare("PRAGMA table_info(sessions_meta)")
        .all()
        .map((row) => String((row as Record<string, unknown>)["name"]));

      expect(columns).toEqual([
        "session_id",
        "client_id",
        "status",
        "session_path",
        "opened_at",
        "closed_at",
        "close_reason",
        "last_event_at",
        "updated_at",
      ]);
    } finally {
      db.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function memoryDataDirFromContext(activeSessionPath: string | undefined): string {
  if (!activeSessionPath) {
    throw new Error("expected active session path");
  }
  const dir = tempDirs[tempDirs.length - 1];
  if (!dir) {
    throw new Error("expected temp data dir");
  }
  return join(dir, activeSessionPath);
}
