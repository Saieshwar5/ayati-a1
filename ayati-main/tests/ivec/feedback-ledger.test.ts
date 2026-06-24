import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncAgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ayati-feedback-ledger-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("AsyncAgentFeedbackLedger", () => {
  it("does not write files when disabled", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: false,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 1,
      stage: "message",
      event: "received",
      data: { content: "hi" },
    });
    await ledger.flush();

    expect(existsSync(join(tempDir, "feedback"))).toBe(false);
  });

  it("writes events asynchronously and updates latest pointer", async () => {
    const times = [
      new Date("2026-06-23T10:00:00.000Z"),
      new Date("2026-06-23T10:00:01.000Z"),
    ];
    let index = 0;
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => times[index++] ?? times[times.length - 1]!,
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 1,
      stage: "message",
      event: "received",
      data: { content: "first" },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: { content: "second" },
    });

    const feedbackPath = join(tempDir, "feedback", "2026-06-23", "session-session-1.jsonl");
    expect(existsSync(feedbackPath)).toBe(false);

    await ledger.flush();

    const lines = (await readFile(feedbackPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)["seq"]).toBe(1);
    expect(JSON.parse(lines[1]!)["seq"]).toBe(2);

    const latest = JSON.parse(await readFile(join(tempDir, "feedback", "latest.json"), "utf-8")) as {
      updatedAt?: string;
      seq?: number;
      runId?: string;
      path?: string;
    };
    expect(latest.updatedAt).toBe("2026-06-23T10:00:01.000Z");
    expect(latest.seq).toBe(2);
    expect(latest.runId).toBe("run-2");
    expect(latest.path).toBe("feedback/2026-06-23/session-session-1.jsonl");
  });

  it("drops oldest events when the queue is full", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      maxQueueSize: 2,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({ sessionId: "session-1", stage: "test", event: "one" });
    ledger.record({ sessionId: "session-1", stage: "test", event: "two" });
    ledger.record({ sessionId: "session-1", stage: "test", event: "three" });
    await ledger.flush();

    const lines = (await readFile(join(tempDir, "feedback", "2026-06-23", "session-session-1.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; event: string; data?: { count?: number } });

    expect(lines.map((line) => `${line.stage}.${line.event}`)).toEqual([
      "feedback.dropped",
      "test.two",
      "test.three",
    ]);
    expect(lines[0]?.data?.count).toBe(1);
  });

  it("does not throw when feedback writes fail", async () => {
    const blockedPath = join(tempDir, "not-a-directory");
    await writeFile(blockedPath, "file");
    const warn = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: blockedPath,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({ sessionId: "session-1", stage: "message", event: "received" });

    await expect(ledger.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
