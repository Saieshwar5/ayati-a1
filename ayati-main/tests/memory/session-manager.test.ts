import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
    expect(context.conversationTurns[1]?.assistantResponseKind).toBe("reply");
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

  it("restores assistant response kinds after restart", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "review this request");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "Should I send the draft?", {
      responseKind: "feedback",
    });

    await memory.shutdown();

    const restored = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    restored.initialize("local");

    const context = restored.getPromptMemoryContext();
    expect(context.conversationTurns.at(-1)).toMatchObject({
      role: "assistant",
      content: "Should I send the draft?",
      assistantResponseKind: "feedback",
    });

    await restored.shutdown();
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
      memory.recordTaskSummary?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/run-${i}`,
        status: "completed",
        taskStatus: "done",
        objective: `task-${i}`,
        summary: `done-${i}`,
        completedMilestones: [`milestone-${i}`],
        openWork: [],
        blockers: [],
        keyFacts: [],
        evidence: [],
        attachmentNames: [],
      });
      memory.recordAssistantFinal("local", run.runId, run.sessionId, `a-${i}`);
    }

    const context = memory.getPromptMemoryContext();
    expect(context.activeSessionPath).toMatch(/^sessions\/.+\.md$/);
    expect(context.recentRunLedgers).toHaveLength(5);
    expect(context.recentTaskSummaries).toHaveLength(5);

    const runIds = (context.recentRunLedgers ?? []).map((item) => item.runId);
    expect(new Set(runIds).size).toBe(5);
    expect((context.recentRunLedgers ?? []).every((item) => item.state === "completed")).toBe(true);
    expect((context.recentTaskSummaries ?? []).map((item) => item.objective)).toEqual([
      "task-5",
      "task-4",
      "task-3",
      "task-2",
      "task-1",
    ]);

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
      memory.recordTaskSummary?.("local", {
        runId: run.runId,
        sessionId: run.sessionId,
        runPath: `data/runs/restart-${i}`,
        status: "completed",
        taskStatus: "done",
        objective: `restart-${i}`,
        summary: `restart-done-${i}`,
        completedMilestones: [],
        openWork: [],
        blockers: [],
        keyFacts: [],
        evidence: [],
        attachmentNames: [],
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
    expect((context.recentTaskSummaries ?? []).map((item) => item.objective)).toEqual([
      "restart-2",
      "restart-1",
      "restart-0",
    ]);

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

    const db = new DatabaseSync(resolve(root, "memory.sqlite"));
    const row = db.prepare(`
      SELECT event_id, source, event_name, status, summary
      FROM system_events
      WHERE event_id = 'evt-1'
    `).get() as {
      event_id: string;
      source: string;
      event_name: string;
      status: string;
      summary: string;
    } | undefined;
    db.close();

    expect(row).toMatchObject({
      event_id: "evt-1",
      source: "pulse",
      event_name: "reminder_due",
      status: "completed",
      summary: "pulse:reminder_due",
    });

    await memory.shutdown();
  });

  it("keeps assistant response types in conversation history and system activity in prompt memory context", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "review this request");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "Should I send the draft?", {
      responseKind: "feedback",
    });
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "Memory usage is 61%", {
      responseKind: "notification",
    });
    memory.recordAssistantNotification?.("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      message: "Memory usage is 61%",
      source: "pulse",
      event: "reminder_due",
      eventId: "evt-2",
    });

    const context = memory.getPromptMemoryContext();
    expect(context.conversationTurns).toHaveLength(3);
    expect(context.conversationTurns.at(-2)).toMatchObject({
      role: "assistant",
      content: "Should I send the draft?",
      assistantResponseKind: "feedback",
    });
    expect(context.conversationTurns.at(-1)).toMatchObject({
      role: "assistant",
      content: "Memory usage is 61%",
      assistantResponseKind: "notification",
    });
    expect(context).not.toHaveProperty("openFeedbacks");
    expect(context.recentSystemActivity).toHaveLength(1);
    expect(context.recentSystemActivity?.[0]?.summary).toBe("Memory usage is 61%");

    await memory.shutdown();
  });

  it("replays legacy feedback events without restoring open feedback state", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const sessionId = "legacy-feedback";
    const sessionPath = `sessions/${sessionId}.md`;
    const sessionFile = resolve(root, sessionPath);
    const openedAt = "2026-02-16T00:00:00.000Z";
    const updatedAt = "2026-02-16T00:00:10.000Z";

    mkdirSync(resolve(root, "sessions"), { recursive: true });
    writeFileSync(
      resolve(root, "sessions", "active-session.json"),
      JSON.stringify({ sessionId, sessionPath }),
      "utf8",
    );

    const metadata = {
      v: 1,
      session_id: sessionId,
      client_id: "local",
      session_path: sessionPath,
      status: "active",
      opened_at: openedAt,
      closed_at: null,
      close_reason: null,
      parent_session_id: null,
      handoff_summary: null,
      updated_at: updatedAt,
    };
    const events = [
      {
        v: 2,
        ts: openedAt,
        type: "session_open",
        sessionId,
        sessionPath,
        clientId: "local",
      },
      {
        v: 2,
        ts: "2026-02-16T00:00:01.000Z",
        type: "user_message",
        sessionId,
        sessionPath,
        runId: "r1",
        content: "review this request",
      },
      {
        v: 2,
        ts: "2026-02-16T00:00:02.000Z",
        type: "assistant_feedback",
        sessionId,
        sessionPath,
        message: "Should I send the draft?",
      },
      {
        v: 2,
        ts: "2026-02-16T00:00:03.000Z",
        type: "feedback_opened",
        sessionId,
        sessionPath,
        runId: "r1",
        feedbackId: "fb-1",
        kind: "approval",
        shortLabel: "send draft",
        message: "Should I send the draft?",
        actionType: "send_email",
        entityHints: ["draft", "email"],
        expiresAt: "2026-02-17T00:00:03.000Z",
      },
    ];
    writeFileSync(
      sessionFile,
      [
        "# Ayati Session",
        "",
        `<!-- AYATI_SESSION_META ${JSON.stringify(metadata)} -->`,
        "",
        "## Events",
        "",
        ...events.map((event) => `<!-- AYATI_EVENT ${JSON.stringify(event)} -->`),
        "",
      ].join("\n"),
      "utf8",
    );

    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const context = memory.getPromptMemoryContext();
    expect(context.activeSessionPath).toBe(sessionPath);
    expect(context.conversationTurns).toHaveLength(2);
    expect(context.conversationTurns.at(-1)).toMatchObject({
      role: "assistant",
      content: "Should I send the draft?",
      assistantResponseKind: "feedback",
    });
    expect(context).not.toHaveProperty("openFeedbacks");

    const resumedRun = memory.beginRun("local", "continue");
    expect(resumedRun.sessionId).toBe(sessionId);

    await memory.shutdown();
  });

  it("prepares handoff asynchronously once context usage reaches 50%", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
      contextTokenLimit: 1_000,
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "u".repeat(1200));
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "a".repeat(1200));

    await memory.updateSessionLifecycle("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      timezone: "Asia/Kolkata",
      status: "completed",
    });
    await memory.flushBackgroundTasks();

    const status = memory.getSessionStatus();
    expect(status?.handoffPhase).toBe("ready");
    expect(status?.pendingRotationReason).toBeNull();

    await memory.shutdown();
  });

  it("finalizes handoff and marks rotation once context usage reaches 70%", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
      contextTokenLimit: 1_000,
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "u".repeat(1600));
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "a".repeat(1600));

    await memory.updateSessionLifecycle("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      timezone: "Asia/Kolkata",
      status: "completed",
    });

    const status = memory.getSessionStatus();
    expect(status?.handoffPhase).toBe("finalized");
    expect(status?.pendingRotationReason).toBe("context_threshold");

    await memory.shutdown();
  });

  it("creates a continuity handoff automatically without carrying open feedback state into the next session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ayati-memory-test-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "please review this");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "Should I send this?");
    memory.recordAssistantFinal("local", run.runId, run.sessionId, "Draft is ready.");

    memory.createSession("local", {
      runId: run.runId,
      reason: "daily_cutover",
      source: "system",
      timezone: "Asia/Kolkata",
    });

    const context = memory.getPromptMemoryContext();
    expect(context.previousSessionSummary.length).toBeGreaterThan(0);
    expect(context).not.toHaveProperty("openFeedbacks");

    await memory.shutdown();
  });
});
