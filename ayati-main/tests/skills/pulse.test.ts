import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pulseSkill, { pulseTool } from "../../src/skills/builtins/pulse/index.js";

let tempDir = "";
let pulsePath = "";
let previousPathEnv: string | undefined;
let previousTzEnv: string | undefined;

function parseOutput(result: { output?: string }): Record<string, unknown> {
  expect(result.output).toBeDefined();
  return JSON.parse(result.output ?? "{}") as Record<string, unknown>;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pulse-tool-test-"));
  pulsePath = join(tempDir, "reminders.json");
  previousPathEnv = process.env["PULSE_STORE_FILE_PATH"];
  previousTzEnv = process.env["PULSE_TIMEZONE"];
  process.env["PULSE_STORE_FILE_PATH"] = pulsePath;
  process.env["PULSE_TIMEZONE"] = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousPathEnv === undefined) {
    delete process.env["PULSE_STORE_FILE_PATH"];
  } else {
    process.env["PULSE_STORE_FILE_PATH"] = previousPathEnv;
  }

  if (previousTzEnv === undefined) {
    delete process.env["PULSE_TIMEZONE"];
  } else {
    process.env["PULSE_TIMEZONE"] = previousTzEnv;
  }

  await rm(tempDir, { recursive: true, force: true });
});

describe("pulse skill metadata", () => {
  it("exposes pulse skill and single tool", () => {
    expect(pulseSkill.id).toBe("pulse");
    expect(pulseSkill.version).toBe("1.0.0");
    expect(pulseSkill.tools).toHaveLength(1);
    expect(pulseSkill.tools[0]?.name).toBe("pulse");
    expect(pulseSkill.promptBlock).toContain("Pulse calendar/reminder");
  });
});

describe("pulse tool", () => {
  it("creates a recurring hourly reminder", async () => {
    const result = await pulseTool.execute(
      {
        action: "create",
        instruction: "Check system health",
        every: "every one hour",
      },
      { clientId: "local", runId: "r1", sessionId: "s1" },
    );

    expect(result.ok).toBe(true);
    const payload = parseOutput(result);
    const reminder = payload["reminder"] as Record<string, unknown>;
    expect(reminder["instruction"]).toBe("Check system health");
    expect(reminder["timezone"]).toBe("UTC");
    expect(reminder["nextTriggerAt"]).toBe("2026-03-01T13:00:00.000Z");

    const schedule = reminder["schedule"] as Record<string, unknown>;
    expect(schedule["kind"]).toBe("interval");
    expect(schedule["everyMs"]).toBe(3_600_000);
  });

  it("creates one-time reminder for tomorrow default time", async () => {
    const result = await pulseTool.execute({
      action: "create",
      title: "Birthday reminder",
      instruction: "Wish girlfriend happy birthday",
      when: "tomorrow",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    const payload = parseOutput(result);
    const reminder = payload["reminder"] as Record<string, unknown>;
    expect(reminder["nextTriggerAt"]).toBe("2026-03-02T09:00:00.000Z");
  });

  it("parses next month day expression", async () => {
    const result = await pulseTool.execute({
      action: "create",
      instruction: "Pay rent",
      when: "after next month 10",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    const payload = parseOutput(result);
    const reminder = payload["reminder"] as Record<string, unknown>;
    expect(reminder["nextTriggerAt"]).toBe("2026-04-10T09:00:00.000Z");
  });

  it("lists and cancels reminders", async () => {
    const create = await pulseTool.execute({
      action: "create",
      instruction: "standup",
      when: "in 2 hours",
    });
    const reminder = (parseOutput(create)["reminder"] as Record<string, unknown>);
    const id = reminder["id"] as string;

    const listBefore = await pulseTool.execute({ action: "list", status: "active" });
    expect(listBefore.ok).toBe(true);
    const beforePayload = parseOutput(listBefore);
    expect(beforePayload["total"]).toBe(1);

    const cancel = await pulseTool.execute({ action: "cancel", id });
    expect(cancel.ok).toBe(true);

    const listAfter = await pulseTool.execute({ action: "list", status: "active" });
    expect(listAfter.ok).toBe(true);
    const afterPayload = parseOutput(listAfter);
    expect(afterPayload["total"]).toBe(0);
  });

  it("returns timezone-aware now snapshot", async () => {
    const result = await pulseTool.execute({ action: "now", timezone: "UTC" });
    expect(result.ok).toBe(true);

    const payload = parseOutput(result);
    const snapshot = payload["snapshot"] as Record<string, unknown>;
    expect(snapshot["nowUtc"]).toBe("2026-03-01T12:00:00.000Z");
    expect(snapshot["localDate"]).toBe("2026-03-01");
    expect(snapshot["timezone"]).toBe("UTC");
  });
});
