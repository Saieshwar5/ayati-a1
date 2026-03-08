import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "../../src/memory/session-manager.js";

function makeNow(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 1, 16, 0, 0, tick++));
}

describe("MemoryManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not auto-rollover session by message count", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    let activeSessionId = "";
    for (let i = 0; i < 10; i++) {
      const run = memory.beginRun("local", `u-${i}`);
      if (i === 0) {
        activeSessionId = run.sessionId;
      }
      expect(run.sessionId).toBe(activeSessionId);

      memory.recordToolCall("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        stepId: i + 1,
        toolCallId: `tc-${i}`,
        toolName: "shell",
        args: { cmd: "echo hi" },
      });
      memory.recordToolResult("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        stepId: i + 1,
        toolCallId: `tc-${i}`,
        toolName: "shell",
        status: "success",
        output: "hi",
      });
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `a-${i}`);
    }

    const eleventh = memory.beginRun("local", "u-10");
    expect(eleventh.sessionId).toBe(activeSessionId);

    await memory.shutdown();
  });

  it("keeps tool events in dynamic memory while conversation window stays countable", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "check tools");
    memory.recordToolCall("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc-1",
      toolName: "shell",
      args: { cmd: "pwd" },
    });
    memory.recordToolResult("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc-1",
      toolName: "shell",
      status: "success",
      output: "/tmp",
    });
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "done");

    const context = memory.getPromptMemoryContext();
    expect(context.conversationTurns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // Tool events are recorded for audit but not returned in prompt context
    expect(context).not.toHaveProperty("toolEvents");

    await memory.shutdown();
  });

  it("creates a new session by closing active session and activating the next one", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "first task");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "done");

    const created = memory.createSession("local", {
      runId: run.runId,
      reason: "new unrelated task",
      source: "agent",
      handoffSummary: "first task completed",
    });

    expect(created.previousSessionId).toBe(run.sessionId);
    expect(created.sessionId).not.toBe(run.sessionId);

    const nextRun = memory.beginRun("local", "second task");
    expect(nextRun.sessionId).toBe(created.sessionId);

    await memory.shutdown();
  });

  it("getPromptMemoryContext returns handoffSummary as previousSessionSummary after session switch", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "first task");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "done");

    memory.createSession("local", {
      runId: run.runId,
      reason: "new topic",
      source: "agent",
      handoffSummary: "Context carried forward: task A done",
    });

    const ctx = memory.getPromptMemoryContext();
    expect(ctx.previousSessionSummary).toBe("Context carried forward: task A done");

    await memory.shutdown();
  });

  it("getPromptMemoryContext returns all conversation turns with no window cap", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    // Add 30 exchanges (60 countable events: 30 user + 30 assistant)
    for (let i = 0; i < 30; i++) {
      const run = memory.beginRun("local", `user-${i}`);
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `assistant-${i}`);
    }

    const ctx = memory.getPromptMemoryContext();
    // All 60 turns must be present — no sliding window
    expect(ctx.conversationTurns).toHaveLength(60);

    await memory.shutdown();
  });

  it("handoffSummary is restored after server restart (replaySessionFile)", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "initial task");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "done");

    const created = memory.createSession("local", {
      runId: run.runId,
      reason: "new topic",
      source: "agent",
      handoffSummary: "Task A completed successfully",
    });

    await memory.shutdown();

    // Simulate server restart — create a new MemoryManager and initialize
    const memory2 = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory2.initialize("local");

    const ctx = memory2.getPromptMemoryContext();
    expect(ctx.previousSessionSummary).toBe("Task A completed successfully");

    const nextRun = memory2.beginRun("local", "resumed work");
    expect(nextRun.sessionId).toBe(created.sessionId);

    await memory2.shutdown();
  });

  it("exposes last 5 unique run ledgers and active session path in prompt context", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    for (let i = 0; i < 6; i++) {
      const run = memory.beginRun("local", `task-${i}`);
      memory.recordRunLedger?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/run-${i}`,
        state: "started",
      });
      memory.recordRunLedger?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/run-${i}`,
        state: "completed",
        status: "completed",
        summary: `done-${i}`,
      });
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `a-${i}`);
    }

    const context = memory.getPromptMemoryContext();
    expect(context.activeSessionPath).toMatch(/^sessions\/.+\.md$/);
    expect(context.recentRunLedgers).toHaveLength(5);

    const runIds = (context.recentRunLedgers ?? []).map((item) => item.runId);
    expect(new Set(runIds).size).toBe(5);
    expect((context.recentRunLedgers ?? []).every((item) => item.state === "completed")).toBe(true);

    await memory.shutdown();
  });

  it("restores recent unique run ledgers after restart", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    for (let i = 0; i < 3; i++) {
      const run = memory.beginRun("local", `restart-${i}`);
      memory.recordRunLedger?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/restart-${i}`,
        state: "started",
      });
      memory.recordRunLedger?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/restart-${i}`,
        state: "completed",
        status: "completed",
        summary: `restart-done-${i}`,
      });
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `reply-${i}`);
    }

    await memory.shutdown();

    const memoryAfterRestart = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memoryAfterRestart.initialize("local");

    const context = memoryAfterRestart.getPromptMemoryContext();
    expect(context.activeSessionPath).toMatch(/^sessions\/.+\.md$/);
    expect(context.recentRunLedgers).toHaveLength(3);
    expect(new Set((context.recentRunLedgers ?? []).map((item) => item.runId)).size).toBe(3);

    await memoryAfterRestart.shutdown();
  });

  it("records system events without adding user conversation turns", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginSystemRun?.("local", {
      source: "pulse",
      event: "reminder_due",
      eventId: "evt-1",
      reminderId: "rem-1",
      instruction: "check health",
    });
    expect(run).toBeDefined();

    memory.recordSystemEventOutcome?.("local", {
      runId: run?.runId ?? "missing",
      eventId: "evt-1",
      source: "pulse",
      event: "reminder_due",
      status: "completed",
      note: "done",
    });

    const context = memory.getPromptMemoryContext();
    expect(context.conversationTurns).toHaveLength(0);

    await memory.shutdown();
  });
});
