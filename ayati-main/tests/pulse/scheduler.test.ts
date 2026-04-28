import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PulseScheduler } from "../../src/pulse/scheduler.js";
import { PulseStore } from "../../src/pulse/store.js";

let tempDir = "";
let storePath = "";
let dbPath = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pulse-scheduler-test-"));
  storePath = join(tempDir, "reminders.json");
  dbPath = join(tempDir, "memory.sqlite");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function recordSystemEventOutcome(
  eventId: string,
  status: "completed" | "failed",
  processedAt: string,
  options?: { runId?: string; note?: string | null },
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_events (
      event_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      processed_at TEXT,
      run_id TEXT,
      note TEXT
    );
  `);
  db.prepare(`
    INSERT INTO system_events (
      event_id,
      status,
      processed_at,
      run_id,
      note
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      status = excluded.status,
      processed_at = excluded.processed_at,
      run_id = excluded.run_id,
      note = excluded.note
  `).run(
    eventId,
    status,
    processedAt,
    options?.runId ?? "run-1",
    options?.note ?? null,
  );
  db.close();
}

describe("PulseScheduler", () => {
  it("dispatches a due reminder once and keeps the occurrence leased until an outcome is recorded", async () => {
    const fixedNow = new Date("2026-03-01T12:00:00.000Z");
    const store = new PulseStore({ filePath: storePath, now: () => fixedNow });
    const reminder = await store.createReminder({
      clientId: "local",
      title: "Birthday",
      instruction: "Wish happy birthday",
      timezone: "UTC",
      schedule: {
        kind: "once",
        at: "2026-03-01T10:00:00.000Z",
      },
      nextTriggerAt: "2026-03-01T10:00:00.000Z",
    });

    const received: Array<{ eventId?: string; payload: Record<string, unknown> }> = [];
    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async (event) => {
        received.push({
          eventId: event.eventId,
          payload: event.payload,
        });
      },
      pollIntervalMs: 10_000,
      now: () => fixedNow,
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual(expect.objectContaining({
      reminderId: reminder.id,
      occurrenceId: `${reminder.id}:2026-03-01T10:00:00.000Z`,
      dispatchAttempt: 1,
    }));

    const details = await store.getItemDetails("local", reminder.id);
    expect(details?.item.nextDueAt).toBe("2026-03-01T10:00:00.000Z");
    expect(details?.occurrences[0]?.status).toBe("leased");
  });

  it("uses latest_only catch-up and advances a recurring reminder after the system-event outcome is recorded", async () => {
    const fixedNow = new Date("2026-03-01T12:00:00.000Z");
    const store = new PulseStore({ filePath: storePath, now: () => fixedNow });
    const reminder = await store.createReminder({
      clientId: "local",
      title: "Health check",
      instruction: "Check health",
      timezone: "UTC",
      schedule: {
        kind: "interval",
        everyMs: 60 * 60 * 1000,
        value: 1,
        unit: "hour",
        anchorAt: "2026-03-01T07:00:00.000Z",
      },
      nextTriggerAt: "2026-03-01T08:00:00.000Z",
    });

    let dispatchedEventId = "";
    const received: Array<Record<string, unknown>> = [];
    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async (event) => {
        dispatchedEventId = event.eventId ?? "";
        received.push(event.payload);
      },
      pollIntervalMs: 10_000,
      now: () => fixedNow,
    });

    await scheduler.runOnce();
    expect(received).toHaveLength(1);
    expect(received[0]?.scheduledFor).toBe("2026-03-01T12:00:00.000Z");

    recordSystemEventOutcome(dispatchedEventId, "completed", "2026-03-01T12:00:10.000Z", { runId: "run-rem-1" });
    await scheduler.runOnce();
    await scheduler.stop();

    const details = await store.getItemDetails("local", reminder.id);
    expect(details?.item.status).toBe("active");
    expect(details?.item.nextDueAt).toBe("2026-03-01T13:00:00.000Z");
    expect(details?.item.lastDueAt).toBe("2026-03-01T12:00:00.000Z");
    expect(details?.occurrences[0]?.status).toBe("completed");
    expect(details?.occurrences[0]?.runId).toBe("run-rem-1");
  });

  it("emits task_due events and completes one-time tasks only after a successful outcome is recorded", async () => {
    const fixedNow = new Date("2026-03-01T12:00:00.000Z");
    const store = new PulseStore({ filePath: storePath, now: () => fixedNow });
    const reminder = await store.createReminder({
      clientId: "local",
      intentKind: "task",
      title: "Health check",
      instruction: "Check system health",
      timezone: "UTC",
      schedule: {
        kind: "once",
        at: "2026-03-01T10:00:00.000Z",
      },
      nextTriggerAt: "2026-03-01T10:00:00.000Z",
      requestedAction: "check_system_health",
      task: {
        objective: "Check system health and report status",
        requestedAction: "check_system_health",
        successCriteria: ["Return current system health summary"],
      },
    });

    const received: Array<{ eventId?: string; eventName: string; payload: Record<string, unknown>; intent?: Record<string, unknown> }> = [];
    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async (event) => {
        received.push({
          eventId: event.eventId,
          eventName: event.eventName,
          payload: event.payload,
          intent: event.intent as Record<string, unknown> | undefined,
        });
      },
      pollIntervalMs: 10_000,
      now: () => fixedNow,
    });

    await scheduler.runOnce();

    expect(received).toHaveLength(1);
    expect(received[0]?.eventName).toBe("task_due");
    expect(received[0]?.intent).toEqual({
      kind: "task",
      eventClass: "trigger_fired",
      trustTier: "internal",
      effectLevel: "act",
      createdBy: "user",
      requestedAction: "check_system_health",
    });
    expect(received[0]?.payload).toEqual(expect.objectContaining({
      scheduledItemId: reminder.id,
      taskId: reminder.id,
      intentKind: "task",
      requestedAction: "check_system_health",
      task: {
        objective: "Check system health and report status",
        requestedAction: "check_system_health",
        successCriteria: ["Return current system health summary"],
      },
    }));

    recordSystemEventOutcome(
      received[0]?.eventId ?? "",
      "completed",
      "2026-03-01T12:00:20.000Z",
      { runId: "run-task-1" },
    );
    await scheduler.runOnce();
    await scheduler.stop();

    const details = await store.getItemDetails("local", reminder.id);
    expect(details?.item.status).toBe("completed");
    expect(details?.item.nextDueAt).toBeNull();
    expect(details?.occurrences[0]?.status).toBe("completed");
    expect(details?.occurrences[0]?.runId).toBe("run-task-1");
  });

  it("retries failed occurrences with exponential backoff", async () => {
    let currentNow = new Date("2026-03-01T12:00:00.000Z");
    const store = new PulseStore({ filePath: storePath, now: () => currentNow });
    const reminder = await store.createReminder({
      clientId: "local",
      title: "Health check",
      instruction: "Check health",
      timezone: "UTC",
      schedule: {
        kind: "once",
        at: "2026-03-01T10:00:00.000Z",
      },
      nextTriggerAt: "2026-03-01T10:00:00.000Z",
    });

    const received: Array<{ eventId?: string; payload: Record<string, unknown> }> = [];
    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async (event) => {
        received.push({ eventId: event.eventId, payload: event.payload });
      },
      pollIntervalMs: 10_000,
      now: () => currentNow,
    });

    await scheduler.runOnce();
    recordSystemEventOutcome(
      received[0]?.eventId ?? "",
      "failed",
      "2026-03-01T12:00:05.000Z",
      { runId: "run-rem-fail-1", note: "temporary_error" },
    );
    await scheduler.runOnce();

    currentNow = new Date("2026-03-01T12:01:05.000Z");
    await scheduler.runOnce();
    await scheduler.stop();

    expect(received).toHaveLength(2);
    expect(received[0]?.payload["occurrenceId"]).toBe(received[1]?.payload["occurrenceId"]);
    expect(received[0]?.payload["dispatchAttempt"]).toBe(1);
    expect(received[1]?.payload["dispatchAttempt"]).toBe(2);

    const details = await store.getItemDetails("local", reminder.id);
    expect(details?.occurrences[0]?.status).toBe("leased");
    expect(details?.occurrences[0]?.attemptCount).toBe(2);
  });
});
