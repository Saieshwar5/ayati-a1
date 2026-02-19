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
});
