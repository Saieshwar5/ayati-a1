import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DailySessionGitStore,
  GitDriver,
  MAIN_BRANCH_REF,
  SESSION_CONVERSATION_PATH,
  buildWorkBranchRef,
  taskFilePath,
  taskStatePath,
} from "../../../src/context-engine/daily-session/index.js";

describe("DailySessionGitStore", () => {
  it("creates a daily bare repo and commits initial main session files idempotently", async () => {
    const contextStoreDir = await tempContextStore();
    const store = new DailySessionGitStore({ contextStoreDir });

    const first = await store.openOrCreateSession({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    });
    const second = await store.openOrCreateSession({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    });

    expect(second.repoPath).toBe(first.repoPath);
    const driver = new GitDriver(first.repoPath);
    const meta = await driver.readFile(MAIN_BRANCH_REF, "session/meta.json");
    expect(meta).toContain('"sessionId": "2026-06-27"');
    const log = await driver.log(MAIN_BRANCH_REF, 5);
    expect(log).toHaveLength(1);
    expect(log[0]?.message).toContain("Ayati-Event: session_started");
  });

  it("stores conversation and assets only on main", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);

    await store.appendConversation({
      sessionId: "2026-06-27",
      role: "user",
      text: "Analyze these files",
      at: "2026-06-27T10:00:00+05:30",
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

    const conversation = await store.readSessionConversationTail("2026-06-27", 5);
    expect(conversation).toEqual([{
      seq: 1,
      role: "user",
      at: "2026-06-27T10:00:00+05:30",
      text: "Analyze these files",
    }]);
    const events = await store.readSessionEventsTail("2026-06-27", 5);
    expect(events.map((event) => event.type)).toEqual(["session_started", "asset_registered"]);
  });

  it("creates orphan task branches, moves focus, and does not copy conversation into task branches", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);
    await store.appendConversation({
      sessionId: "2026-06-27",
      role: "user",
      text: "Fix upload bug",
      at: "2026-06-27T10:00:00+05:30",
    });

    const task = await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      title: "Fix upload bug",
      objective: "Fix the upload bug.",
      createdAt: "2026-06-27T10:00:10+05:30",
      state: {
        completed: [],
        open: ["Inspect upload path"],
        facts: [],
        next: "Inspect upload path",
      },
    });
    await store.updateFocus({
      sessionId: "2026-06-27",
      ref: task.ref,
      at: "2026-06-27T10:00:12+05:30",
    });

    expect(task.ref).toBe(buildWorkBranchRef("W-20260627-0001", "Fix upload bug"));
    expect(await store.readFocus("2026-06-27")).toBe(task.ref);
    expect(await store.listTaskBranches("2026-06-27")).toMatchObject([{
      workId: "W-20260627-0001",
      ref: task.ref,
      branch: "work/W-20260627-0001-fix-upload-bug",
    }]);

    const driver = new GitDriver(join(contextStoreDir, "sessions", "2026-06-27.git"));
    expect(await driver.readFile(task.ref, SESSION_CONVERSATION_PATH)).toBeNull();
    expect(await driver.readFile(MAIN_BRANCH_REF, taskFilePath("W-20260627-0001"))).toBeNull();
  });

  it("commits one completed run to the task branch and records the run on main", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);
    await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      title: "Analyze files",
      objective: "Analyze the attached files.",
      createdAt: "2026-06-27T10:00:10+05:30",
    });

    const result = await store.commitRun({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      runId: "R-20260627-0001",
      state: {
        schemaVersion: 1,
        workId: "W-20260627-0001",
        status: "active",
        completed: ["Read contract.pdf"],
        open: ["Write final summary"],
        facts: [{ text: "The contract has a 30-day termination clause.", source: "R-20260627-0001/action-0001" }],
        next: "Write final summary",
      },
      runSummary: {
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId: "W-20260627-0001",
        status: "completed",
        summary: "Read the attached contract and extracted key terms.",
        completed: ["Read contract.pdf"],
        open: ["Write final summary"],
        actions: ["action-0001"],
        createdAt: "2026-06-27T10:25:00+05:30",
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
          summary: "Read contract.pdf and extracted text.",
          createdAt: "2026-06-27T10:05:00+05:30",
        },
        output: "contract text excerpt",
      }],
      finalOutput: {
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId: "W-20260627-0001",
        kind: "final",
        content: { answer: "The contract has a 30-day termination clause." },
        createdAt: "2026-06-27T10:25:00+05:30",
      },
    });

    const state = await store.readTaskState("2026-06-27", "W-20260627-0001");
    expect(state?.completed).toEqual(["Read contract.pdf"]);
    expect(await store.readTaskRunSummaries("2026-06-27", "W-20260627-0001", 5)).toMatchObject([{
      runId: "R-20260627-0001",
      summary: "Read the attached contract and extracted key terms.",
    }]);

    const commitLog = await store.readTaskCommitLog("2026-06-27", "W-20260627-0001", 2);
    expect(commitLog[0]).toMatchObject({
      commit: result.workCommit,
      trailers: {
        sessionId: "2026-06-27",
        workId: "W-20260627-0001",
        runId: "R-20260627-0001",
        event: "run_completed",
      },
    });

    const driver = new GitDriver(join(contextStoreDir, "sessions", "2026-06-27.git"));
    expect(await driver.resolveRef(result.runRef)).toBe(result.workCommit);
    const action = await driver.readFile(commitLog[0]!.commit, "tasks/W-20260627-0001/actions/R-20260627-0001/action-0001.json");
    expect(action).toContain('"outputRef"');
    expect(await driver.readFile(commitLog[0]!.commit, "tasks/W-20260627-0001/actions/R-20260627-0001/action-0001-output.txt")).toBe(
      "contract text excerpt",
    );
    const events = await store.readSessionEventsTail("2026-06-27", 5);
    expect(events.at(-1)).toMatchObject({
      type: "run_committed",
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
      commit: result.workCommit,
    });
    expect(await driver.readFile(MAIN_BRANCH_REF, taskStatePath("W-20260627-0001"))).toBeNull();
  });
});

async function tempContextStore(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ayati-context-store-"));
}

async function openedStore(contextStoreDir: string): Promise<DailySessionGitStore> {
  const store = new DailySessionGitStore({ contextStoreDir });
  await store.openOrCreateSession({
    sessionId: "2026-06-27",
    timezone: "Asia/Kolkata",
    createdAt: "2026-06-27T00:00:00+05:30",
  });
  return store;
}
