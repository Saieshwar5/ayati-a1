import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DailySessionGitStore,
  DailySessionRuntimeBridge,
  dailySessionIdForDate,
} from "../../../src/context-engine/daily-session/index.js";

describe("DailySessionRuntimeBridge", () => {
  it("derives daily session ids in the configured timezone", () => {
    const date = new Date("2026-06-26T20:00:00.000Z");

    expect(dailySessionIdForDate(date, "UTC")).toBe("2026-06-26");
    expect(dailySessionIdForDate(date, "Asia/Kolkata")).toBe("2026-06-27");
  });

  it("prepares a new task and allocates run ids from git run refs", async () => {
    const store = new DailySessionGitStore({ contextStoreDir: await tempContextStore() });
    const runtime = new DailySessionRuntimeBridge({ store, timezone: "Asia/Kolkata" });

    const first = await runtime.prepareUserTurn({
      userMessage: "Analyze invoice",
      at: "2026-06-27T10:00:00+05:30",
    });
    expect(first).toMatchObject({
      status: "ready",
      sessionId: "2026-06-27",
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
    });
    if (first.status !== "ready") {
      throw new Error("Expected ready turn.");
    }

    await runtime.completePreparedRun({
      sessionId: first.sessionId,
      workId: first.workId,
      runId: first.runId,
      state: {
        schemaVersion: 1,
        workId: first.workId,
        status: "active",
        completed: ["Read invoice"],
        open: ["Summarize invoice"],
        facts: [],
      },
      runSummary: {
        schemaVersion: 1,
        runId: first.runId,
        workId: first.workId,
        status: "completed",
        summary: "Read invoice.",
        completed: ["Read invoice"],
        open: ["Summarize invoice"],
        actions: [],
        createdAt: "2026-06-27T10:05:00+05:30",
      },
      actions: [],
      assistantMessage: "I read the invoice.",
      at: "2026-06-27T10:05:00+05:30",
    });

    const second = await runtime.prepareUserTurn({
      userMessage: "continue",
      at: "2026-06-27T10:06:00+05:30",
    });
    expect(second).toMatchObject({
      status: "ready",
      sessionId: "2026-06-27",
      runId: "R-20260627-0002",
      workId: first.workId,
    });
  });

  it("returns an ambiguity message without allocating a run id", async () => {
    const store = new DailySessionGitStore({ contextStoreDir: await tempContextStore() });
    const runtime = new DailySessionRuntimeBridge({ store, timezone: "Asia/Kolkata" });
    await store.openOrCreateSession({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    });
    const uploadBug = await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      title: "Fix upload bug",
      objective: "Fix upload failure.",
    });
    await store.updateFocus({
      sessionId: "2026-06-27",
      ref: uploadBug.ref,
    });
    await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0002",
      title: "Upload UI redesign",
      objective: "Redesign upload UI.",
    });

    const turn = await runtime.prepareUserTurn({
      userMessage: "upload",
      at: "2026-06-27T10:00:00+05:30",
    });

    expect(turn.status).toBe("ambiguous");
    if (turn.status === "ambiguous") {
      expect(turn.message).toContain("I found multiple matching tasks");
      expect(turn.message).toContain("W-20260627-0001");
      expect(turn.message).toContain("W-20260627-0002");
      expect("runId" in turn).toBe(false);
    }
  });
});

async function tempContextStore(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ayati-daily-runtime-"));
}
