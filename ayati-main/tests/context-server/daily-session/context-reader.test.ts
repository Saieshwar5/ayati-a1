import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DailySessionContextReader,
  DailySessionGitStore,
  GitDriver,
  FOCUS_CURRENT_REF,
  buildWorkBranchRef,
  SESSION_CONVERSATION_PATH,
} from "../../../src/context-server/daily-session/index.js";

describe("DailySessionContextReader", () => {
  it("builds active context from main conversation and focused task branch", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await seededStore(contextStoreDir);
    const reader = new DailySessionContextReader(store);

    const context = await reader.buildActiveContext({
      sessionId: "2026-06-27",
      limits: {
        conversationTailLimit: 2,
        eventTailLimit: 3,
        runSummaryLimit: 1,
        commitLogLimit: 1,
      },
    });

    expect(context.session.conversationTail.map((message) => message.text)).toEqual([
      "continue the same task",
      "finish it",
    ]);
    expect(context.session.assets.map((asset) => asset.assetId)).toEqual(["A-20260627-0001"]);
    expect(context.focus).toMatchObject({
      status: "active",
      workId: "W-20260627-0001",
    });
    expect(context.task?.task).toMatchObject({
      workId: "W-20260627-0001",
      title: "Analyze files",
    });
    expect(context.task?.state.completed).toEqual(["Read contract.pdf", "Extracted termination clause"]);
    expect(context.task?.recentRuns.map((run) => run.runId)).toEqual(["R-20260627-0002"]);
    expect(context.task?.recentCommits).toHaveLength(1);
    expect(context.task?.recentCommits[0]?.trailers.runId).toBe("R-20260627-0002");

    const driver = new GitDriver(join(contextStoreDir, "sessions", "2026-06-27.git"));
    const taskRef = buildWorkBranchRef("W-20260627-0001", "Analyze files");
    expect(await driver.readFile(taskRef, SESSION_CONVERSATION_PATH)).toBeNull();
  });

  it("returns session-only context when no focus ref exists", async () => {
    const contextStoreDir = await tempContextStore();
    const store = new DailySessionGitStore({ contextStoreDir });
    await store.openOrCreateSession({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    });
    await store.appendConversation({
      sessionId: "2026-06-27",
      role: "user",
      text: "hello",
      at: "2026-06-27T10:00:00+05:30",
    });

    const context = await new DailySessionContextReader(store).buildActiveContext({
      sessionId: "2026-06-27",
    });

    expect(context.focus).toEqual({ status: "none" });
    expect(context.task).toBeUndefined();
    expect(context.session.conversationTail).toHaveLength(1);
  });

  it("reports a missing focus branch without scanning for replacement work", async () => {
    const contextStoreDir = await tempContextStore();
    const store = new DailySessionGitStore({ contextStoreDir });
    await store.openOrCreateSession({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    });
    const driver = new GitDriver(join(contextStoreDir, "sessions", "2026-06-27.git"));
    await driver.setSymbolicRef(FOCUS_CURRENT_REF, "refs/heads/work/W-20260627-9999-missing-task");

    const context = await new DailySessionContextReader(store).buildActiveContext({
      sessionId: "2026-06-27",
    });

    expect(context.focus).toMatchObject({
      status: "missing",
      ref: "refs/heads/work/W-20260627-9999-missing-task",
      workId: "W-20260627-9999",
    });
    expect(context.task).toBeUndefined();
  });
});

async function tempContextStore(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ayati-context-reader-"));
}

async function seededStore(contextStoreDir: string): Promise<DailySessionGitStore> {
  const store = new DailySessionGitStore({ contextStoreDir });
  await store.openOrCreateSession({
    sessionId: "2026-06-27",
    timezone: "Asia/Kolkata",
    createdAt: "2026-06-27T00:00:00+05:30",
  });
  await store.appendConversation({
    sessionId: "2026-06-27",
    role: "user",
    text: "Analyze these files",
    at: "2026-06-27T10:00:00+05:30",
  });
  await store.appendConversation({
    sessionId: "2026-06-27",
    role: "assistant",
    text: "I will inspect the attached files first.",
    at: "2026-06-27T10:00:05+05:30",
  });
  await store.appendConversation({
    sessionId: "2026-06-27",
    role: "user",
    text: "continue the same task",
    at: "2026-06-27T10:20:00+05:30",
  });
  await store.appendConversation({
    sessionId: "2026-06-27",
    role: "user",
    text: "finish it",
    at: "2026-06-27T10:30:00+05:30",
  });
  await store.registerAsset({
    sessionId: "2026-06-27",
    asset: {
      assetId: "A-20260627-0001",
      kind: "user_file",
      name: "contract.pdf",
      path: "/home/user/contract.pdf",
      sha256: "abc123",
      createdAt: "2026-06-27T10:00:00+05:30",
    },
  });
  const task = await store.createTaskBranch({
    sessionId: "2026-06-27",
    workId: "W-20260627-0001",
    title: "Analyze files",
    objective: "Analyze the attached files.",
    createdAt: "2026-06-27T10:00:10+05:30",
    assets: [{
      assetId: "A-20260627-0001",
      role: "input",
      kind: "user_file",
      name: "contract.pdf",
      sessionAssetId: "A-20260627-0001",
    }],
  });
  await store.updateFocus({
    sessionId: "2026-06-27",
    ref: task.ref,
    at: "2026-06-27T10:00:12+05:30",
  });
  await store.commitRun({
    sessionId: "2026-06-27",
    workId: "W-20260627-0001",
    runId: "R-20260627-0001",
    state: {
      schemaVersion: 1,
      workId: "W-20260627-0001",
      status: "active",
      completed: ["Read contract.pdf"],
      open: ["Extract termination clause"],
      facts: [],
    },
    runSummary: {
      schemaVersion: 1,
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
      status: "completed",
      summary: "Read the attached contract.",
      completed: ["Read contract.pdf"],
      open: ["Extract termination clause"],
      actions: ["action-0001"],
      createdAt: "2026-06-27T10:10:00+05:30",
    },
    actions: [{
      action: {
        schemaVersion: 1,
        actionId: "action-0001",
        runId: "R-20260627-0001",
        workId: "W-20260627-0001",
        tool: "read_file",
        input: { path: "/home/user/contract.pdf" },
        status: "success",
        summary: "Read contract.pdf.",
        createdAt: "2026-06-27T10:05:00+05:30",
      },
    }],
  });
  await store.commitRun({
    sessionId: "2026-06-27",
    workId: "W-20260627-0001",
    runId: "R-20260627-0002",
    state: {
      schemaVersion: 1,
      workId: "W-20260627-0001",
      status: "active",
      completed: ["Read contract.pdf", "Extracted termination clause"],
      open: ["Write final summary"],
      facts: [{ text: "The contract has a 30-day termination clause.", source: "R-20260627-0002/action-0001" }],
      next: "Write final summary",
    },
    runSummary: {
      schemaVersion: 1,
      runId: "R-20260627-0002",
      workId: "W-20260627-0001",
      status: "completed",
      summary: "Extracted the termination clause.",
      completed: ["Extracted termination clause"],
      open: ["Write final summary"],
      actions: ["action-0001"],
      createdAt: "2026-06-27T10:25:00+05:30",
    },
    actions: [{
      action: {
        schemaVersion: 1,
        actionId: "action-0001",
        runId: "R-20260627-0002",
        workId: "W-20260627-0001",
        tool: "document_query",
        input: { query: "termination clause" },
        status: "success",
        summary: "Found termination clause.",
        createdAt: "2026-06-27T10:22:00+05:30",
      },
    }],
  });
  return store;
}
