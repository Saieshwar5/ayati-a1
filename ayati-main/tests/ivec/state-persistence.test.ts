import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initRunDirectory,
  writeJSON,
  writeState,
  readState,
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
        userMessage: "hello",
        goal: goalContract("greet"),
        approach: "direct",
        constraints: [],
        taskStatus: "not_done",
        progressLedger: {
          lastSuccessfulStepSummary: "",
          lastStepFacts: [],
          taskEvidence: [],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        completedSteps: [],
        runPath,
        failedApproaches: [],
        sessionHistory: [],
        recentRunLedgers: [],
      };
      writeState(runPath, state);
      const loaded = readState(runPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe("run-456");
      expect(loaded!.finalOutput).toBe("");
      expect(loaded).not.toHaveProperty("sessionHistory");
      expect(loaded).not.toHaveProperty("recentRunLedgers");
    } finally {
      cleanup();
    }
  });

  it("readState strips transient context from legacy state files", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-legacy");
      const legacyState: LoopState = {
        runId: "run-legacy",
        userMessage: "hello",
        goal: goalContract("greet"),
        approach: "direct",
        constraints: [],
        taskStatus: "not_done",
        progressLedger: {
          lastSuccessfulStepSummary: "",
          lastStepFacts: [],
          taskEvidence: [],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        completedSteps: [],
        runPath,
        failedApproaches: [],
        sessionHistory: [{ role: "user", content: "hi", timestamp: "2026-03-07T00:00:00.000Z", sessionPath: "sessions/x.md" }],
        recentRunLedgers: [{ timestamp: "2026-03-07T00:00:00.000Z", runId: "r-1", runPath: "/tmp/r-1", state: "completed", status: "completed", summary: "done" }],
      };

      writeJSON(runPath, "state.json", legacyState);
      const loaded = readState(runPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe("run-legacy");
      expect(loaded).not.toHaveProperty("sessionHistory");
      expect(loaded).not.toHaveProperty("recentRunLedgers");
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
});
