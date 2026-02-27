import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/memory/session-manager.js";

function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSessionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function findSessionFile(baseDir: string, sessionId: string): string {
  const files = listSessionFiles(join(baseDir, "sessions"));
  const match = files.find((file) => file.endsWith(`${sessionId}.md`));
  if (!match) {
    throw new Error(`Session file not found for ${sessionId}`);
  }
  return match;
}

describe("MemoryManager markdown persistence", () => {
  it("stores compact run memory and returns prompt context", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c1");

    const run = manager.beginRun("c1", "find learn1.go");
    manager.recordToolCall("c1", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "find . -name learn1.go" },
    });

    manager.recordToolResult("c1", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "./work_space/calculus/learn1.go",
      durationMs: 22,
    });

    manager.recordAssistantFinal("c1", run.runId, run.sessionId, "Found the file path.");

    const prompt = manager.getPromptMemoryContext();

    expect(prompt.conversationTurns.length).toBeGreaterThanOrEqual(1);
    // Tool events are recorded to JSONL audit log but not returned in prompt context
    expect(prompt).not.toHaveProperty("toolEvents");

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).not.toContain("\"tool_result\"");
    expect(content).toContain("\"session_open\"");
    expect(content).toContain("\"sessionPath\"");
    expect(content).not.toContain("\"runId\"");

    manager.shutdown();
  });

  it("writes session files directly under sessions directory", () => {
    const now = new Date("2026-02-08T12:30:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-date");
    const run = manager.beginRun("c-date", "hello");
    manager.recordAssistantFinal("c-date", run.runId, run.sessionId, "hey");

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const normalized = sessionFile.replace(/\\/g, "/");
    expect(normalized).toMatch(/\/sessions\/[^/]+\.md$/);

    manager.shutdown();
  });

  it("keeps active-session.json on shutdown so session can resume", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const markerPath = join(baseDir, "sessions", "active-session.json");

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-marker");
    expect(existsSync(markerPath)).toBe(false);

    const run = manager.beginRun("c-marker", "ping");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      sessionId: string;
      sessionPath: string;
    };
    expect(marker.sessionId).toBe(run.sessionId);
    expect(marker.sessionPath).toMatch(/^sessions\/[^/]+\.md$/);

    manager.shutdown();
    expect(existsSync(markerPath)).toBe(true);

    const manager2 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager2.initialize("c-marker");
    const resumed = manager2.beginRun("c-marker", "resume");
    expect(resumed.sessionId).toBe(run.sessionId);
    manager2.shutdown();
  });

  it("tracks sessions in sqlite sessions_meta with metadata-only schema", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const dbPath = join(baseDir, "memory.sqlite");

    const manager = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-sqlite");
    const run = manager.beginRun("c-sqlite", "hello");
    manager.recordAssistantFinal("c-sqlite", run.runId, run.sessionId, "world");
    manager.shutdown();

    const db = new DatabaseSync(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));

    expect(tableNames.has("sessions_meta")).toBe(true);
    expect(tableNames.has("session_metadata")).toBe(false);

    const columns = db
      .prepare("PRAGMA table_info(sessions_meta)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((row) => row.name));

    expect(columnNames.has("keywords_json")).toBe(false);
    expect(columnNames.has("session_path")).toBe(true);
    expect(columnNames.has("parent_session_id")).toBe(true);
    expect(columnNames.has("handoff_summary")).toBe(true);
    expect(columnNames.has("countable_event_count")).toBe(false);

    const row = db
      .prepare(`
        SELECT status, session_path, parent_session_id, handoff_summary
        FROM sessions_meta
        WHERE session_id = ?
      `)
      .get(run.sessionId) as {
        status: string;
        session_path: string;
        parent_session_id: string | null;
        handoff_summary: string | null;
      };

    expect(row.status).toBe("active");
    expect(row.session_path).toMatch(/^sessions\/[^/]+\.md$/);
    expect(row.parent_session_id).toBeNull();
    expect(row.handoff_summary).toBeNull();

    db.close();
  });

  it("restores active session via marker after restart", () => {
    let now = new Date("2026-02-08T08:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager1 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager1.initialize("c-restart");
    const run = manager1.beginRun("c-restart", "hello");
    manager1.recordAssistantFinal("c-restart", run.runId, run.sessionId, "hey there");

    // Simulate crash (no shutdown)
    now = new Date("2026-02-08T08:05:00.000Z");
    const manager2 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager2.initialize("c-restart");
    const next = manager2.beginRun("c-restart", "next");
    expect(next.sessionId).toBe(run.sessionId);

    const prompt = manager2.getPromptMemoryContext();
    expect(prompt.conversationTurns.length).toBeGreaterThanOrEqual(3);
    expect(prompt.conversationTurns.every((turn) => turn.sessionPath.includes("sessions/"))).toBe(true);

    manager2.shutdown();
  });

  it("migrates legacy active .jsonl session to .md on restore", () => {
    const now = new Date("2026-02-16T13:50:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const dbPath = join(baseDir, "memory.sqlite");
    const sessionId = "legacy-active-session";
    const legacyPath = `sessions/2026/02/16/${sessionId}.jsonl`;
    const markdownPath = `sessions/2026/02/16/${sessionId}.md`;
    const legacyAbsolutePath = join(baseDir, legacyPath);
    const markerPath = join(baseDir, "sessions", "active-session.json");

    mkdirSync(join(baseDir, "sessions", "2026", "02", "16"), { recursive: true });
    writeFileSync(legacyAbsolutePath, [
      JSON.stringify({
        v: 2,
        ts: "2026-02-16T13:46:51.871Z",
        type: "session_open",
        sessionId,
        sessionPath: legacyPath,
        clientId: "local",
      }),
      JSON.stringify({
        v: 2,
        ts: "2026-02-16T13:46:51.872Z",
        type: "user_message",
        sessionId,
        sessionPath: legacyPath,
        content: "hii",
      }),
      JSON.stringify({
        v: 2,
        ts: "2026-02-16T13:46:53.776Z",
        type: "assistant_message",
        sessionId,
        sessionPath: legacyPath,
        content: "Hey there!",
      }),
    ].join("\n"), "utf8");
    writeFileSync(markerPath, JSON.stringify({ sessionId, sessionPath: legacyPath }), "utf8");

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_meta (
        session_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'crashed')),
        session_path TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        close_reason TEXT,
        parent_session_id TEXT,
        handoff_summary TEXT,
        last_event_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO sessions_meta (
        session_id,
        client_id,
        status,
        session_path,
        opened_at,
        closed_at,
        close_reason,
        parent_session_id,
        handoff_summary,
        last_event_at,
        updated_at
      ) VALUES (?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      sessionId,
      "local",
      legacyPath,
      "2026-02-16T13:46:51.871Z",
      "2026-02-16T13:46:53.776Z",
      "2026-02-16T13:46:53.776Z",
    );
    db.close();

    const manager = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("local");
    const resumed = manager.beginRun("local", "continue");
    expect(resumed.sessionId).toBe(sessionId);

    const updatedMarker = JSON.parse(readFileSync(markerPath, "utf8")) as { sessionPath: string };
    expect(updatedMarker.sessionPath).toBe(markdownPath);
    expect(existsSync(join(baseDir, markdownPath))).toBe(true);
    expect(existsSync(legacyAbsolutePath)).toBe(false);

    const migratedContent = readFileSync(join(baseDir, markdownPath), "utf8");
    expect(migratedContent).toContain("\"type\":\"session_open\"");
    expect(migratedContent).toContain("\"type\":\"assistant_message\"");

    manager.shutdown();
  });

  it("restores tool activity when active session is reloaded", () => {
    let now = new Date("2026-02-08T10:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager1 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager1.initialize("c-restart-tools");
    const run = manager1.beginRun("c-restart-tools", "check tool state");
    manager1.recordToolCall("c-restart-tools", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc-restart-1",
      toolName: "shell",
      args: { cmd: "pwd" },
    });
    manager1.recordToolResult("c-restart-tools", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc-restart-1",
      toolName: "shell",
      status: "success",
      output: "/workspace",
    });
    manager1.recordAssistantFinal("c-restart-tools", run.runId, run.sessionId, "done");

    // Simulate crash (no shutdown)
    now = new Date("2026-02-08T10:05:00.000Z");
    const manager2 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager2.initialize("c-restart-tools");
    const prompt = manager2.getPromptMemoryContext();
    // Tool events are written to JSONL for audit, not fed into prompt context
    expect(prompt).not.toHaveProperty("toolEvents");
    expect(prompt.conversationTurns.length).toBeGreaterThanOrEqual(1);

    const resumed = manager2.beginRun("c-restart-tools", "continue");
    expect(resumed.sessionId).toBe(run.sessionId);

    manager2.shutdown();
  });

  it("falls back to marker restore when sqlite active row has stale path", () => {
    const now = new Date("2026-02-08T09:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const dbPath = join(baseDir, "memory.sqlite");
    const markerPath = join(baseDir, "sessions", "active-session.json");

    const manager1 = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager1.initialize("c-stale-active");
    const run = manager1.beginRun("c-stale-active", "hello");
    manager1.recordAssistantFinal("c-stale-active", run.runId, run.sessionId, "world");
    manager1.shutdown();

    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      sessionId: string;
      sessionPath: string;
    };
    expect(marker.sessionId).toBe(run.sessionId);

    const db = new DatabaseSync(dbPath);
    db.prepare(`
      UPDATE sessions_meta
      SET
        session_path = 'sessions/invalid/missing.md',
        status = 'active',
        closed_at = NULL,
        close_reason = NULL
      WHERE session_id = ?
    `).run(run.sessionId);
    db.close();

    const manager2 = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager2.initialize("c-stale-active");
    const resumed = manager2.beginRun("c-stale-active", "resume");
    expect(resumed.sessionId).toBe(run.sessionId);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare(`
      SELECT status, session_path
      FROM sessions_meta
      WHERE session_id = ?
    `).get(run.sessionId) as { status: string; session_path: string };
    expect(row.status).toBe("active");
    expect(row.session_path).toBe(marker.sessionPath);
    db2.close();

    manager2.shutdown();
  });

  it("recovers last crashed session when marker is missing", () => {
    const now = new Date("2026-02-08T09:30:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const dbPath = join(baseDir, "memory.sqlite");
    const markerPath = join(baseDir, "sessions", "active-session.json");

    const manager1 = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager1.initialize("c-recover-crashed");
    const run = manager1.beginRun("c-recover-crashed", "start");
    manager1.recordAssistantFinal("c-recover-crashed", run.runId, run.sessionId, "ok");
    manager1.shutdown();

    try {
      unlinkSync(markerPath);
    } catch {
      // ignore
    }

    const db = new DatabaseSync(dbPath);
    db.prepare(`
      UPDATE sessions_meta
      SET
        status = 'crashed',
        close_reason = 'restore_failed',
        closed_at = ?,
        updated_at = ?
      WHERE session_id = ?
    `).run(now.toISOString(), now.toISOString(), run.sessionId);
    db.close();

    const manager2 = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager2.initialize("c-recover-crashed");
    const resumed = manager2.beginRun("c-recover-crashed", "continue");
    expect(resumed.sessionId).toBe(run.sessionId);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare(`
      SELECT status
      FROM sessions_meta
      WHERE session_id = ?
    `).get(run.sessionId) as { status: string };
    expect(row.status).toBe("active");
    db2.close();

    manager2.shutdown();
  });

  it("hydrates active session window after restart", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager1 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager1.initialize("c-hydrate");
    for (let i = 0; i < 12; i++) {
      const run = manager1.beginRun("c-hydrate", `user ${i}`);
      manager1.recordAssistantFinal("c-hydrate", run.runId, run.sessionId, `assistant ${i}`);
    }
    manager1.shutdown();

    const manager2 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });
    manager2.initialize("c-hydrate");

    const prompt = manager2.getPromptMemoryContext();
    // All 24 turns are returned — no sliding window cap
    expect(prompt.conversationTurns).toHaveLength(24);
    expect(prompt.conversationTurns[0]?.content).toBe("user 0");
    expect(prompt.conversationTurns[23]?.content).toBe("assistant 11");

    manager2.shutdown();
  });

  it("does not rotate session when 20 countable events are reached", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-rotate");

    let firstSessionId = "";
    for (let i = 0; i < 10; i++) {
      const run = manager.beginRun("c-rotate", `user ${i}`);
      manager.recordAssistantFinal("c-rotate", run.runId, run.sessionId, `assistant ${i}`);
      if (!firstSessionId) firstSessionId = run.sessionId;
      expect(run.sessionId).toBe(firstSessionId);
    }

    const next = manager.beginRun("c-rotate", "after limit");
    expect(next.sessionId).toBe(firstSessionId);

    manager.shutdown();
  });

  it("create_session atomically closes current session and opens new active session with handoff", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const dbPath = join(baseDir, "memory.sqlite");

    const manager = new SessionManager({
      dbPath,
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-switch");
    const run = manager.beginRun("c-switch", "start task");
    manager.recordAssistantFinal("c-switch", run.runId, run.sessionId, "done");

    const switched = manager.createSession("c-switch", {
      runId: run.runId,
      reason: "new unrelated task",
      source: "agent",
      handoffSummary: "task 1 completed with shell output",
    });

    expect(switched.previousSessionId).toBe(run.sessionId);
    expect(switched.sessionId).not.toBe(run.sessionId);
    expect(switched.sessionPath.endsWith(".md")).toBe(true);

    const oldContent = readFileSync(findSessionFile(baseDir, run.sessionId), "utf8");
    expect(oldContent).toContain("\"type\":\"session_close\"");
    expect(oldContent).toContain("\"handoffSummary\":\"task 1 completed with shell output\"");

    const newContent = readFileSync(findSessionFile(baseDir, switched.sessionId), "utf8");
    expect(newContent).toContain("\"type\":\"session_open\"");
    expect(newContent).toContain("\"handoffSummary\":\"task 1 completed with shell output\"");
    expect(newContent).toContain("\"status\":\"session_switched\"");

    const db = new DatabaseSync(dbPath);
    const oldRow = db.prepare(`
      SELECT status, close_reason, handoff_summary
      FROM sessions_meta
      WHERE session_id = ?
    `).get(run.sessionId) as { status: string; close_reason: string; handoff_summary: string | null };
    const newRow = db.prepare(`
      SELECT status, parent_session_id, handoff_summary
      FROM sessions_meta
      WHERE session_id = ?
    `).get(switched.sessionId) as { status: string; parent_session_id: string | null; handoff_summary: string | null };

    expect(oldRow.status).toBe("closed");
    expect(oldRow.close_reason).toContain("session_switch:");
    expect(oldRow.handoff_summary).toBe("task 1 completed with shell output");
    expect(newRow.status).toBe("active");
    expect(newRow.parent_session_id).toBe(run.sessionId);
    expect(newRow.handoff_summary).toBe("task 1 completed with shell output");
    db.close();

    manager.shutdown();
  });

  it("does not persist tool-context or tool-output side stores", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-tool");

    const run = manager.beginRun("c-tool", "list files");
    manager.recordToolCall("c-tool", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      args: { cmd: "ls -la" },
    });

    manager.recordToolResult("c-tool", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      status: "success",
      output: "file1.txt\nfile2.txt",
      durationMs: 15,
    });

    expect(existsSync(join(baseDir, "tool-context"))).toBe(false);
    expect(existsSync(join(baseDir, "tool-output"))).toBe(false);

    manager.shutdown();
  });

  it("stores full tool output text inside session markdown document in debug mode", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
      memoryDetailMode: "debug",
    });

    manager.initialize("c-full-output");

    const run = manager.beginRun("c-full-output", "run command");
    const fullOutput = `${"x".repeat(2500)}__tail__`;
    manager.recordToolCall("c-full-output", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      args: { cmd: "cat huge.log" },
    });
    manager.recordToolResult("c-full-output", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      status: "success",
      output: fullOutput,
    });

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain(fullOutput);

    manager.shutdown();
  });

  it("stores run ledger and task summary pointers", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-ledger");

    const run = manager.beginRun("c-ledger", "summarize run pointers");
    manager.recordRunLedger?.("c-ledger", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/r-ledger-1",
      state: "started",
    });
    manager.recordRunLedger?.("c-ledger", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/r-ledger-1",
      state: "completed",
      status: "completed",
      summary: "Completed run",
    });
    manager.recordTaskSummary?.("c-ledger", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/r-ledger-1",
      status: "completed",
      summary: "Completed run",
    });
    manager.recordAssistantFinal("c-ledger", run.runId, run.sessionId, "done");

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain("\"type\":\"run_ledger\"");
    expect(content).toContain("\"type\":\"task_summary\"");
    expect(content).toContain("\"runPath\":\"data/runs/r-ledger-1\"");

    manager.shutdown();
  });

  it("does not store agent_step events in compact mode", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c-agent-step-compact");

    const run = manager.beginRun("c-agent-step-compact", "test compact agent step");
    manager.recordAgentStep("c-agent-step-compact", {
      runId: run.runId,
      sessionId: run.sessionId,
      step: 1,
      phase: "progress",
      summary: "Step 1 progress",
    });
    manager.recordAssistantFinal("c-agent-step-compact", run.runId, run.sessionId, "done");

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).not.toContain("\"type\":\"agent_step\"");

    manager.shutdown();
  });

  it("stores agent_step events in debug mode", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
      memoryDetailMode: "debug",
    });

    manager.initialize("c-agent-step-debug");

    const run = manager.beginRun("c-agent-step-debug", "test debug agent step");
    manager.recordAgentStep("c-agent-step-debug", {
      runId: run.runId,
      sessionId: run.sessionId,
      step: 1,
      phase: "progress",
      summary: "Step 1 progress",
    });
    manager.recordAssistantFinal("c-agent-step-debug", run.runId, run.sessionId, "done");

    const sessionFile = findSessionFile(baseDir, run.sessionId);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain("\"type\":\"agent_step\"");

    manager.shutdown();
  });
});
