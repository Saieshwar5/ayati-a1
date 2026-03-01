import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PulseScheduler } from "../../src/pulse/scheduler.js";
import { PulseStore } from "../../src/pulse/store.js";

let tempDir = "";
let storePath = "";
const fixedNow = new Date("2026-03-01T12:00:00.000Z");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pulse-scheduler-test-"));
  storePath = join(tempDir, "reminders.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PulseScheduler", () => {
  it("delivers missed one-time reminder once on start", async () => {
    const store = new PulseStore({ filePath: storePath, now: () => fixedNow });
    await store.createReminder({
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

    const received: string[] = [];
    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async (event) => {
        received.push(event.reminderId);
      },
      pollIntervalMs: 10_000,
      now: () => fixedNow,
    });

    await scheduler.start();
    await scheduler.stop();

    expect(received).toHaveLength(1);

    const reminders = await store.listReminders({ clientId: "local", status: "all" });
    expect(reminders[0]?.status).toBe("completed");
    expect(reminders[0]?.nextTriggerAt).toBeNull();
  });

  it("advances recurring reminder after catch-up delivery", async () => {
    const store = new PulseStore({ filePath: storePath, now: () => fixedNow });
    await store.createReminder({
      clientId: "local",
      title: "Health check",
      instruction: "Check health",
      timezone: "UTC",
      schedule: {
        kind: "interval",
        everyMs: 60 * 60 * 1000,
        anchorAt: "2026-03-01T07:00:00.000Z",
      },
      nextTriggerAt: "2026-03-01T08:00:00.000Z",
    });

    const scheduler = new PulseScheduler({
      clientId: "local",
      store,
      onReminderDue: async () => undefined,
      pollIntervalMs: 10_000,
      now: () => fixedNow,
    });

    await scheduler.start();
    await scheduler.stop();

    const reminders = await store.listReminders({ clientId: "local", status: "all" });
    expect(reminders[0]?.status).toBe("active");
    expect(reminders[0]?.nextTriggerAt).toBe("2026-03-01T13:00:00.000Z");
  });
});
