import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryManager } from "../../src/memory/session-manager.js";

function makeNow(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 5, 12, 10, tick++));
}

describe("focus memory", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates an attention shelf item from durable artifact work", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-focus-memory-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "create a todo app");
    memory.recordTaskSummary("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/run-1",
      status: "completed",
      taskStatus: "done",
      objective: "Create a todo app",
      summary: "Created todo/index.html and todo/style.css for a todo app.",
      completedMilestones: ["todo/index.html written", "todo/style.css written"],
      keyFacts: ["todo/index.html exists"],
      evidence: ["todo/style.css exists and was verified"],
      entityHints: ["todo app", "task list"],
    });

    const shelf = memory.getPromptMemoryContext().attentionShelf ?? [];
    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.type).toBe("artifact_work");
    expect(shelf[0]?.summary).toContain("todo");
    expect(shelf[0]?.topArtifacts).toContain("todo/index.html");

    await memory.shutdown();
  });

  it("does not create focus memory for one-off question answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-focus-memory-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const run = memory.beginRun("local", "what is the capital of Japan?");
    memory.recordTaskSummary("local", {
      runId: run.runId,
      sessionId: run.sessionId,
      runPath: "data/runs/run-1",
      status: "completed",
      taskStatus: "done",
      objective: "What is the capital of Japan?",
      summary: "The capital of Japan is Tokyo.",
      completedMilestones: [],
      openWork: [],
      keyFacts: [],
      evidence: [],
    });

    expect(memory.getPromptMemoryContext().attentionShelf ?? []).toHaveLength(0);

    await memory.shutdown();
  });

  it("updates an existing focus when later work touches the same artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-focus-memory-"));
    dirs.push(root);
    const memory = new MemoryManager({
      dataDir: root,
      dbPath: resolve(root, "memory.sqlite"),
      now: makeNow(),
    });
    memory.initialize("local");

    const first = memory.beginRun("local", "create a todo app");
    memory.recordTaskSummary("local", {
      runId: first.runId,
      sessionId: first.sessionId,
      runPath: "data/runs/run-1",
      status: "completed",
      taskStatus: "done",
      objective: "Create a todo app",
      summary: "Created todo/index.html and todo/style.css.",
      evidence: ["todo/index.html exists", "todo/style.css exists"],
      entityHints: ["todo app"],
    });

    const second = memory.beginRun("local", "make it responsive too");
    memory.recordTaskSummary("local", {
      runId: second.runId,
      sessionId: second.sessionId,
      runPath: "data/runs/run-2",
      status: "completed",
      taskStatus: "done",
      objective: "Make the todo app responsive",
      summary: "Updated todo/style.css with responsive layout rules.",
      evidence: ["todo/style.css was modified and verified"],
      entityHints: ["todo app", "responsive"],
    });

    const shelf = memory.getPromptMemoryContext().attentionShelf ?? [];
    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.summary).toContain("responsive");
    expect(shelf[0]?.topArtifacts).toContain("todo/style.css");

    await memory.shutdown();
  });
});

