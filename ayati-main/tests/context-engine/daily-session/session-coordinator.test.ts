import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DailySessionCoordinator,
  DailySessionGitStore,
  type PreparedUserTurn,
} from "../../../src/context-engine/daily-session/index.js";

describe("DailySessionCoordinator", () => {
  it("opens the session, records the user turn, creates the first task, and focuses it", async () => {
    const { store, coordinator } = await coordinatorFixture();

    const turn = await coordinator.prepareUserTurn({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      userMessage: "Analyze new invoice",
      at: "2026-06-27T10:00:00+05:30",
    });

    expectReady(turn);
    expect(turn.resolution).toMatchObject({
      mode: "create_new",
      title: "Analyze new invoice",
      objective: "Analyze new invoice",
    });
    expect(turn.selected.workId).toBe("W-20260627-0001");
    expect(turn.createdTask).toMatchObject({
      workId: "W-20260627-0001",
      ref: turn.selected.ref,
    });
    expect(await store.readFocus("2026-06-27")).toBe(turn.selected.ref);
    expect(await store.readSessionConversationTail("2026-06-27", 5)).toEqual([{
      seq: 1,
      role: "user",
      at: "2026-06-27T10:00:00+05:30",
      text: "Analyze new invoice",
    }]);
    expect(turn.context.focus).toMatchObject({
      status: "active",
      workId: "W-20260627-0001",
    });
    expect(turn.context.task).toMatchObject({
      workId: "W-20260627-0001",
      title: "Analyze new invoice",
      objective: "Analyze new invoice",
      open: ["Analyze new invoice"],
      next: "Analyze new invoice",
    });
  });

  it("switches focus to an existing task when the resolver selects another work branch", async () => {
    const { store, coordinator } = await seededCoordinatorFixture();

    const turn = await coordinator.prepareUserTurn({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      userMessage: "continue contract analysis",
      at: "2026-06-27T10:05:00+05:30",
    });

    expectReady(turn);
    expect(turn.resolution).toMatchObject({
      mode: "switch_existing",
      workId: "W-20260627-0002",
    });
    expect(turn.selected.workId).toBe("W-20260627-0002");
    expect(await store.readFocus("2026-06-27")).toBe(turn.selected.ref);
    expect(turn.createdTask).toBeUndefined();
    expect(turn.context.task).toMatchObject({
      workId: "W-20260627-0002",
      title: "Contract analysis",
      open: ["Write risk summary"],
    });
  });

  it("returns ambiguous candidates without creating a branch or moving focus", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);
    const coordinator = new DailySessionCoordinator({ store });
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
      objective: "Redesign the upload user interface.",
    });

    const turn = await coordinator.prepareUserTurn({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      userMessage: "upload",
      at: "2026-06-27T10:10:00+05:30",
    });

    expect(turn.status).toBe("ambiguous");
    if (turn.status === "ambiguous") {
      expect(turn.resolution.candidates.map((candidate) => candidate.workId).sort()).toEqual([
        "W-20260627-0001",
        "W-20260627-0002",
      ]);
    }
    expect(await store.readFocus("2026-06-27")).toBe(uploadBug.ref);
    expect(await store.listTaskBranches("2026-06-27")).toHaveLength(2);
    expect(turn.context.focus).toMatchObject({
      status: "active",
      workId: "W-20260627-0001",
    });
  });

  it("commits a completed run, records the assistant reply, and returns updated task context", async () => {
    const { store, coordinator } = await coordinatorFixture();
    const turn = await coordinator.prepareUserTurn({
      sessionId: "2026-06-27",
      timezone: "Asia/Kolkata",
      userMessage: "Analyze new invoice",
      at: "2026-06-27T10:00:00+05:30",
    });
    expectReady(turn);
    const workId = turn.selected.workId;

    const completed = await coordinator.completePreparedRun({
      sessionId: "2026-06-27",
      workId,
      runId: "R-20260627-0001",
      state: {
        schemaVersion: 1,
        workId,
        status: "active",
        completed: ["Read invoice.pdf"],
        open: ["Write final answer"],
        facts: [{
          text: "The invoice total is 1200.",
          source: "R-20260627-0001/action-0001",
        }],
        next: "Write final answer",
      },
      runSummary: {
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId,
        status: "completed",
        summary: "Read the invoice and extracted the total.",
        completed: ["Read invoice.pdf"],
        open: ["Write final answer"],
        actions: ["action-0001"],
        createdAt: "2026-06-27T10:12:00+05:30",
      },
      actions: [{
        schemaVersion: 1,
        actionId: "action-0001",
        runId: "R-20260627-0001",
        workId,
        tool: "read_file",
        input: { path: "/home/user/invoice.pdf" },
        status: "success",
        summary: "Read invoice.pdf.",
        createdAt: "2026-06-27T10:05:00+05:30",
      }],
      finalOutput: {
        schemaVersion: 1,
        runId: "R-20260627-0001",
        workId,
        kind: "final",
        content: { answer: "The invoice total is 1200." },
        createdAt: "2026-06-27T10:12:00+05:30",
      },
      assistantMessage: "I read the invoice and found the total.",
      at: "2026-06-27T10:12:00+05:30",
    });

    expect(completed.run.runRef).toBe("refs/ayati/runs/R-20260627-0001");
    expect(completed.assistantConversation).toMatchObject({
      seq: 2,
      role: "assistant",
      text: "I read the invoice and found the total.",
    });
    expect(await store.readSessionConversationTail("2026-06-27", 5)).toMatchObject([
      { role: "user", text: "Analyze new invoice" },
      { role: "assistant", text: "I read the invoice and found the total." },
    ]);
    expect(await store.readTaskState("2026-06-27", workId)).toMatchObject({
      completed: ["Read invoice.pdf"],
      open: ["Write final answer"],
      next: "Write final answer",
    });
    expect(completed.context.task).toMatchObject({
      workId,
      completed: ["Read invoice.pdf"],
      recentRuns: [{
        runId: "R-20260627-0001",
        summary: "Read the invoice and extracted the total.",
      }],
    });
    expect(completed.context.task?.recentCommits[0]?.subject).toBe(`complete run R-20260627-0001 for ${workId}`);
  });
});

async function tempContextStore(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ayati-session-coordinator-"));
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

async function coordinatorFixture(): Promise<{
  store: DailySessionGitStore;
  coordinator: DailySessionCoordinator;
}> {
  const store = new DailySessionGitStore({ contextStoreDir: await tempContextStore() });
  return {
    store,
    coordinator: new DailySessionCoordinator({ store }),
  };
}

async function seededCoordinatorFixture(): Promise<{
  store: DailySessionGitStore;
  coordinator: DailySessionCoordinator;
}> {
  const store = await openedStore(await tempContextStore());
  const uploadBug = await store.createTaskBranch({
    sessionId: "2026-06-27",
    workId: "W-20260627-0001",
    title: "Fix upload bug",
    objective: "Fix upload failure without changing public API.",
    state: {
      completed: ["Located upload handler"],
      open: ["Add regression test"],
      facts: [],
      next: "Add regression test",
    },
  });
  await store.updateFocus({
    sessionId: "2026-06-27",
    ref: uploadBug.ref,
  });
  await store.createTaskBranch({
    sessionId: "2026-06-27",
    workId: "W-20260627-0002",
    title: "Contract analysis",
    objective: "Analyze the attached contract.",
    assets: [{
      assetId: "A-20260627-0001",
      role: "input",
      kind: "user_file",
      name: "contract.pdf",
      sessionAssetId: "A-20260627-0001",
      path: "/home/user/contract.pdf",
    }],
    state: {
      completed: ["Read contract.pdf"],
      open: ["Write risk summary"],
      facts: [],
      next: "Write risk summary",
    },
  });
  return {
    store,
    coordinator: new DailySessionCoordinator({ store }),
  };
}

function expectReady(turn: PreparedUserTurn): asserts turn is Extract<PreparedUserTurn, { status: "ready" }> {
  if (turn.status !== "ready") {
    throw new Error(`Expected ready turn, got ${turn.status}`);
  }
}
