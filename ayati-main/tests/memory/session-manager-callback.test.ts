import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../../src/memory/session-manager.js";
import type {
  HandoffSummaryIndexData,
  SessionCloseData,
  TaskSummaryIndexData,
} from "../../src/memory/session-manager.js";

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sm-cb-test-"));
}

describe("SessionManager onSessionClose callback", () => {
  let tmpDir: string;
  let dataDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    dataDir = join(tmpDir, "data");
    dbPath = join(tmpDir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not fire callback on shutdown while session remains active", async () => {
    const callback = vi.fn();

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
      onSessionClose: callback,
    });

    sm.initialize("client1");

    const run1 = sm.beginRun("client1", "Hello");
    sm.recordAssistantFinal("client1", run1.runId, run1.sessionId, "Hi there!");

    const run2 = sm.beginRun("client1", "How are you?");
    sm.recordAssistantFinal("client1", run2.runId, run2.sessionId, "I'm good!");

    await sm.shutdown();

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires callback when create_session closes active session", async () => {
    const callback = vi.fn();
    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
      onSessionClose: callback,
    });

    sm.initialize("client1");

    const run = sm.beginRun("client1", "u0");
    sm.recordAssistantFinal("client1", run.runId, run.sessionId, "a0");
    const firstSessionId = run.sessionId;
    sm.createSession("client1", {
      runId: run.runId,
      reason: "new unrelated task",
      source: "agent",
    });

    await sm.flushBackgroundTasks();

    expect(callback).toHaveBeenCalledTimes(1);
    const data: SessionCloseData = callback.mock.calls[0]![0]!;
    expect(data.sessionId).toBe(firstSessionId);
    expect(data.reason).toBe("session_switch:new unrelated task");
    expect(data.turns.length).toBe(2);

    await sm.shutdown();
  });

  it("does not auto-close on time changes before explicit create_session", async () => {
    const callback = vi.fn();
    let time = new Date("2025-01-01T00:00:00Z");

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => time,
      onSessionClose: callback,
    });

    sm.initialize("client1");

    const run1 = sm.beginRun("client1", "Hello");
    sm.recordAssistantFinal("client1", run1.runId, run1.sessionId, "Hi");

    time = new Date("2025-01-02T05:00:00Z");
    const run2 = sm.beginRun("client1", "Still same session");
    sm.recordAssistantFinal("client1", run2.runId, run2.sessionId, "Yep");

    await sm.flushBackgroundTasks();
    expect(callback).toHaveBeenCalledTimes(0);

    await sm.shutdown();
    expect(callback).toHaveBeenCalledTimes(0);
  });

  it("agent step events are recorded to audit log but not included in prompt context", async () => {
    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    sm.initialize("client1");

    const run = sm.beginRun("client1", "Hello");
    sm.recordAgentStep("client1", {
      runId: run.runId,
      sessionId: run.sessionId,
      step: 1,
      phase: "reason",
      summary: "Analyze user greeting",
      actionToolName: undefined,
    });
    sm.recordAgentStep("client1", {
      runId: run.runId,
      sessionId: run.sessionId,
      step: 2,
      phase: "act",
      summary: "Generate friendly response",
      actionToolName: "respond",
    });
    sm.recordAssistantFinal("client1", run.runId, run.sessionId, "Hi there!");

    const context = sm.getPromptMemoryContext();
    // Agent step events are no longer fed into the prompt context
    expect(context).not.toHaveProperty("agentStepEvents");
    expect(context.conversationTurns).toHaveLength(2);

    await sm.shutdown();
  });

  it("awaits async onSessionClose callback via flushBackgroundTasks", async () => {
    const order: string[] = [];

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
      onSessionClose: async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("callback-done");
      },
    });

    sm.initialize("client1");
    const run = sm.beginRun("client1", "u0");
    sm.recordAssistantFinal("client1", run.runId, run.sessionId, "a0");
    sm.createSession("client1", {
      runId: run.runId,
      reason: "next task",
      source: "agent",
    });

    await sm.flushBackgroundTasks();
    order.push("flush-done");

    expect(order).toEqual(["callback-done", "flush-done"]);
    await sm.shutdown();
  });

  it("fires task summary indexing callback after task summaries are recorded", async () => {
    const onTaskSummaryIndexed = vi.fn();

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
      onTaskSummaryIndexed,
    });

    sm.initialize("client1");
    const run = sm.beginRun("client1", "Summarize this");
    sm.recordTaskSummary("client1", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/r-1",
      status: "completed",
      summary: "Completed the task",
    });

    await sm.flushBackgroundTasks();

    expect(onTaskSummaryIndexed).toHaveBeenCalledTimes(1);
    const data: TaskSummaryIndexData = onTaskSummaryIndexed.mock.calls[0]![0]!;
    expect(data.sessionId).toBe(run.sessionId);
    expect(data.summary).toBe("Completed the task");
    expect(data.runPath).toBe("data/runs/r-1");

    await sm.shutdown();
  });

  it("fires handoff summary indexing callback when a session is rotated", async () => {
    const onHandoffSummaryIndexed = vi.fn();

    const sm = new SessionManager({
      dataDir,
      dbPath,
      now: () => new Date("2025-01-01T00:00:00Z"),
      onHandoffSummaryIndexed,
    });

    sm.initialize("client1");
    const run = sm.beginRun("client1", "Task A");
    sm.recordAssistantFinal("client1", run.runId, run.sessionId, "Done");
    const firstSessionId = run.sessionId;

    sm.createSession("client1", {
      runId: run.runId,
      reason: "new topic",
      source: "agent",
      handoffSummary: "Task A completed successfully",
    });

    await sm.flushBackgroundTasks();

    expect(onHandoffSummaryIndexed).toHaveBeenCalledTimes(1);
    const data: HandoffSummaryIndexData = onHandoffSummaryIndexed.mock.calls[0]![0]!;
    expect(data.sessionId).toBe(firstSessionId);
    expect(data.summary).toBe("Task A completed successfully");

    await sm.shutdown();
  });
});
