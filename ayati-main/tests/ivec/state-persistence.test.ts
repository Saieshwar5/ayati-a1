import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initRunDirectory,
  writeJSON,
  writeState,
  readState,
  queueStateWrite,
  flushStateWrites,
  queueStepMarkdownWrite,
  writeStepArtifactText,
} from "../../src/ivec/state-persistence.js";
import type { LoopState } from "../../src/ivec/types.js";

function goalContract(objective: string): LoopState["goal"] {
  return {
    objective,
    done_when: [`${objective} is complete`],
    required_evidence: [],
    ask_user_when: [],
    stop_when_no_progress: [],
  };
}

describe("state-persistence", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-sp-"));
    return tmpDir;
  }

  function cleanup(): void {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("initRunDirectory creates directory and steps/ subdirectory", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-123");
      expect(existsSync(runPath)).toBe(true);
      expect(existsSync(join(runPath, "steps"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("writeState + readState roundtrip", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-456");
      const state: LoopState = {
        runId: "run-456",
        runClass: "interaction",
        userMessage: "hello",
        goal: goalContract("greet"),
        approach: "direct",
        sessionContextSummary: "",
        dependentTask: false,
        dependentTaskSummary: null,
        taskProgress: {
          status: "not_done",
          progressSummary: "",
          keyFacts: [],
          evidence: [],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        approachChangeCount: 0,
        completedSteps: [],
        recentContextSearches: [],
        runPath,
        failedApproaches: [],
        sessionHistory: [],
        recentRunLedgers: [],
        recentTaskSummaries: [],
        recentSystemActivity: [],
      };
      writeState(runPath, state);
      const loaded = readState(runPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe("run-456");
      expect(loaded!.finalOutput).toBe("");
      expect(loaded).not.toHaveProperty("sessionHistory");
      expect(loaded).not.toHaveProperty("recentRunLedgers");
      expect(loaded).not.toHaveProperty("recentTaskSummaries");
    } finally {
      cleanup();
    }
  });

  it("queues async state snapshots and flushes the latest persisted state", async () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-async");
      const state: LoopState = {
        runId: "run-async",
        runClass: "interaction",
        userMessage: "hello",
        goal: goalContract("greet"),
        approach: "direct",
        sessionContextSummary: "",
        dependentTask: true,
        dependentTaskSummary: {
          timestamp: "2026-03-07T00:00:00.000Z",
          runId: "dep-1",
          runPath: "/tmp/dep-1",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Earlier task",
          summary: "Earlier task finished",
          completedMilestones: ["done"],
          openWork: [],
          blockers: [],
          keyFacts: ["fact"],
          evidence: ["proof"],
          attachmentNames: [],
        },
        taskProgress: {
          status: "not_done",
          progressSummary: "",
          keyFacts: [],
          evidence: [],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        approachChangeCount: 0,
        completedSteps: [],
        recentContextSearches: [],
        runPath,
        failedApproaches: [],
        sessionHistory: [{ role: "user", content: "hello", timestamp: "", sessionPath: "" }],
        recentRunLedgers: [{ timestamp: "2026-03-07T00:00:00.000Z", runId: "r-1", runPath: "/tmp/r-1", state: "completed" }],
        recentTaskSummaries: [{ runId: "r-1", runPath: "/tmp/r-1", status: "completed", summary: "done" }],
        activeSessionAttachments: [],
        recentSystemActivity: [],
      };

      const firstWrite = queueStateWrite(runPath, state);
      state.finalOutput = "latest";
      state.iteration = 2;
      const secondWrite = queueStateWrite(runPath, state);

      expect(existsSync(join(runPath, "state.json"))).toBe(false);

      await Promise.all([firstWrite, secondWrite]);
      await flushStateWrites(runPath);

      const persisted = JSON.parse(readFileSync(join(runPath, "state.json"), "utf-8")) as {
        dependentTask?: boolean;
        dependentTaskSummary?: { runId?: string };
        finalOutput?: string;
        iteration?: number;
        sessionHistory?: unknown;
        recentRunLedgers?: unknown;
        recentTaskSummaries?: unknown;
      };
      expect(persisted.dependentTask).toBe(true);
      expect(persisted.dependentTaskSummary?.runId).toBe("dep-1");
      expect(persisted.finalOutput).toBe("latest");
      expect(persisted.iteration).toBe(2);
      expect(persisted).not.toHaveProperty("sessionHistory");
      expect(persisted).not.toHaveProperty("recentRunLedgers");
      expect(persisted).not.toHaveProperty("recentTaskSummaries");
    } finally {
      cleanup();
    }
  });

  it("readState strips transient context from state files", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-current");
      const persistedState = {
        runId: "run-current",
        runClass: "interaction",
        userMessage: "hello",
        goal: goalContract("greet"),
        approach: "direct",
        sessionContextSummary: "",
        dependentTask: false,
        dependentTaskSummary: null,
        taskProgress: {
          status: "not_done",
          progressSummary: "",
          keyFacts: [],
          evidence: [],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        approachChangeCount: 0,
        completedSteps: [],
        recentContextSearches: [],
        runPath,
        failedApproaches: [],
        sessionHistory: [{ role: "user", content: "hi", timestamp: "2026-03-07T00:00:00.000Z", sessionPath: "sessions/x.md" }],
        recentRunLedgers: [{ timestamp: "2026-03-07T00:00:00.000Z", runId: "r-1", runPath: "/tmp/r-1", state: "completed", status: "completed", summary: "done" }],
        recentTaskSummaries: [],
        recentSystemActivity: [],
      };

      writeJSON(runPath, "state.json", persistedState);
      const loaded = readState(runPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe("run-current");
      expect(loaded).not.toHaveProperty("sessionHistory");
      expect(loaded).not.toHaveProperty("recentRunLedgers");
      expect(loaded).not.toHaveProperty("recentTaskSummaries");
    } finally {
      cleanup();
    }
  });

  it("readState returns null for missing file", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-missing");
      const result = readState(join(runPath, "nonexistent"));
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("writes queued step markdown and raw text artifacts", async () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-artifacts");
      await Promise.all([
        queueStepMarkdownWrite(runPath, "steps/001-act.md", "# Act Output\n\nhello"),
        writeStepArtifactText(runPath, "steps/001-call-01-raw.txt", "raw-output"),
      ]);

      expect(existsSync(join(runPath, "steps", "001-act.md"))).toBe(true);
      expect(existsSync(join(runPath, "steps", "001-call-01-raw.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
