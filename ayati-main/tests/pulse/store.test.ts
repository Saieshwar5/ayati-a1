import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PulseStore } from "../../src/pulse/store.js";

let tempDir = "";
let storePath = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pulse-store-test-"));
  storePath = join(tempDir, "reminders.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("PulseStore", () => {
  it("defaults legacy reminder records to reminder intent", async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        reminders: [
          {
            id: "rem-legacy-1",
            clientId: "local",
            title: "Legacy reminder",
            instruction: "Wish happy birthday",
            timezone: "UTC",
            status: "active",
            schedule: {
              kind: "once",
              at: "2026-03-02T09:00:00.000Z",
            },
            nextTriggerAt: "2026-03-02T09:00:00.000Z",
            createdAt: "2026-03-01T10:00:00.000Z",
            updatedAt: "2026-03-01T10:00:00.000Z",
            metadata: {},
          },
        ],
      }, null, 2),
      "utf8",
    );

    const store = new PulseStore({ filePath: storePath });
    const reminders = await store.listReminders({ clientId: "local", status: "all" });

    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.intentKind).toBe("reminder");
    expect(reminders[0]?.requestedAction).toBeUndefined();
  });

  it("normalizes stored task reminders with structured task payload", async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        reminders: [
          {
            id: "task-1",
            clientId: "local",
            intentKind: "task",
            title: "Memory usage",
            instruction: "Check memory usage",
            timezone: "UTC",
            status: "active",
            schedule: {
              kind: "interval",
              everyMs: 600000,
              anchorAt: "2026-03-01T10:00:00.000Z",
            },
            nextTriggerAt: "2026-03-01T10:10:00.000Z",
            createdAt: "2026-03-01T10:00:00.000Z",
            updatedAt: "2026-03-01T10:00:00.000Z",
            task: {
              objective: "Check current machine memory usage and report it",
              requestedAction: "check_memory_usage",
            },
            metadata: {},
          },
        ],
      }, null, 2),
      "utf8",
    );

    const store = new PulseStore({ filePath: storePath });
    const reminders = await store.listReminders({ clientId: "local", status: "all" });

    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.requestedAction).toBe("check_memory_usage");
    expect(reminders[0]?.task).toEqual({
      objective: "Check current machine memory usage and report it",
      requestedAction: "check_memory_usage",
    });
    expect(reminders[0]?.schedule).toEqual(expect.objectContaining({
      kind: "interval",
      everyMs: 600000,
      value: 10,
      unit: "minute",
    }));
  });
});
