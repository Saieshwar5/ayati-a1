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

  it("writes a compact latest summary when final feedback summary data is present", async () => {
    const ledger = new AsyncAgentFeedbackLedger({
      dataDir: tempDir,
      enabled: true,
      now: () => new Date("2026-06-23T10:00:00.000Z"),
    });

    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 3,
          toolCalls: 2,
          toolLoadDecisions: 1,
          actionSteps: 1,
          verificationPassed: true,
          basedOnVerifiedFacts: true,
          warnings: [],
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      status?: string;
      responseKind?: string;
      iterations?: number;
      toolCalls?: number;
      toolLoadDecisions?: number;
      actionSteps?: number;
      verificationPassed?: boolean;
      basedOnVerifiedFacts?: boolean;
      warnings?: string[];
      rawPath?: string;
    };

    expect(summary.status).toBe("completed");
    expect(summary.responseKind).toBe("reply");
    expect(summary.iterations).toBe(3);
    expect(summary.toolCalls).toBe(2);
    expect(summary.toolLoadDecisions).toBe(1);
    expect(summary.actionSteps).toBe(1);
    expect(summary.verificationPassed).toBe(true);
    expect(summary.basedOnVerifiedFacts).toBe(true);
    expect(summary.warnings).toEqual([]);
    expect(summary.rawPath).toBe("feedback/2026-06-23/session-session-1.jsonl");
  });

  it("merges decision repair signals into the latest summary warnings", async () => {
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
      seq: 2,
      stage: "decision",
      event: "parse_failed",
      data: { attempt: 1, error: "Expected JSON object" },
    });
    ledger.record({
      clientId: "local",
      sessionId: "session-1",
      seq: 2,
      runId: "run-2",
      stage: "final",
      event: "reply",
      data: {
        feedbackSummary: {
          status: "completed",
          responseKind: "reply",
          iterations: 1,
          toolCalls: 0,
          warnings: ["completed_without_tool_calls"],
        },
      },
    });
    await ledger.flush();

    const summary = JSON.parse(await readFile(join(tempDir, "feedback", "latest-summary.json"), "utf-8")) as {
      warnings?: string[];
    };

    expect(summary.warnings).toEqual(["completed_without_tool_calls", "parse_repair_needed"]);
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
