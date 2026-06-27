import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DailySessionGitStore,
  DailySessionTaskResolver,
} from "../../../src/context-server/daily-session/index.js";

describe("DailySessionTaskResolver", () => {
  it("continues the focused task when an explicit work id matches focus", async () => {
    const store = await seededResolverStore();
    const resolver = new DailySessionTaskResolver(store);

    const result = await resolver.resolve({
      sessionId: "2026-06-27",
      userMessage: "continue W-20260627-0001",
    });

    expect(result).toMatchObject({
      mode: "continue_focus",
      workId: "W-20260627-0001",
      reason: "explicit work id matched active focus",
    });
  });

  it("switches to an existing task when an explicit work id names another branch", async () => {
    const store = await seededResolverStore();
    const resolver = new DailySessionTaskResolver(store);

    const result = await resolver.resolve({
      sessionId: "2026-06-27",
      userMessage: "go back to W-20260627-0002",
    });

    expect(result).toMatchObject({
      mode: "switch_existing",
      workId: "W-20260627-0002",
      reason: "explicit work id matched existing task",
    });
  });

  it("continues focus for pure follow-up language", async () => {
    const store = await seededResolverStore();
    const resolver = new DailySessionTaskResolver(store);

    const result = await resolver.resolve({
      sessionId: "2026-06-27",
      userMessage: "finish it",
    });

    expect(result).toMatchObject({
      mode: "continue_focus",
      workId: "W-20260627-0001",
      reason: "follow-up phrase with active focus",
    });
  });

  it("switches to a task when the message matches title tokens", async () => {
    const store = await seededResolverStore();
    const resolver = new DailySessionTaskResolver(store);

    const result = await resolver.resolve({
      sessionId: "2026-06-27",
      userMessage: "continue contract analysis",
    });

    expect(result).toMatchObject({
      mode: "switch_existing",
      workId: "W-20260627-0002",
    });
    expect(result.reason).toContain("task title");
  });

  it("switches to a task when the message mentions a task asset", async () => {
    const store = await seededResolverStore();
    const resolver = new DailySessionTaskResolver(store);

    const result = await resolver.resolve({
      sessionId: "2026-06-27",
      userMessage: "use contract.pdf again",
    });

    expect(result).toMatchObject({
      mode: "switch_existing",
      workId: "W-20260627-0002",
      reason: "asset name matched",
    });
  });

  it("returns ambiguous when multiple tasks partially match", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);
    const uploadBug = await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      title: "Fix upload bug",
      objective: "Fix the upload bug.",
    });
    await store.updateFocus({ sessionId: "2026-06-27", ref: uploadBug.ref });
    await store.createTaskBranch({
      sessionId: "2026-06-27",
      workId: "W-20260627-0002",
      title: "Upload UI redesign",
      objective: "Redesign the upload user interface.",
    });

    const result = await new DailySessionTaskResolver(store).resolve({
      sessionId: "2026-06-27",
      userMessage: "upload",
    });

    expect(result.mode).toBe("ambiguous");
    if (result.mode === "ambiguous") {
      expect(result.reason).toBe("multiple existing tasks matched partially");
      expect(result.candidates.map((candidate) => candidate.workId).sort()).toEqual([
        "W-20260627-0001",
        "W-20260627-0002",
      ]);
    }
  });

  it("creates a new task when no existing branch matches deterministically", async () => {
    const store = await seededResolverStore();

    const result = await new DailySessionTaskResolver(store).resolve({
      sessionId: "2026-06-27",
      userMessage: "plan my workout",
    });

    expect(result).toEqual({
      mode: "create_new",
      title: "plan my workout",
      objective: "plan my workout",
      confidence: "deterministic",
      reason: "no existing task matched deterministically",
    });
  });

  it("creates a new task for pure follow-up language when there is no focus", async () => {
    const contextStoreDir = await tempContextStore();
    const store = await openedStore(contextStoreDir);

    const result = await new DailySessionTaskResolver(store).resolve({
      sessionId: "2026-06-27",
      userMessage: "continue",
    });

    expect(result).toEqual({
      mode: "create_new",
      title: "continue",
      objective: "continue",
      confidence: "deterministic",
      reason: "follow-up phrase had no active focus",
    });
  });
});

async function tempContextStore(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ayati-task-resolver-"));
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

async function seededResolverStore(): Promise<DailySessionGitStore> {
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
  await store.updateFocus({ sessionId: "2026-06-27", ref: uploadBug.ref });
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
  return store;
}
