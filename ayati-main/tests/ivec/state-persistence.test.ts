import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initRunDirectory,
  writeJSON,
  readState,
} from "../../src/ivec/state-persistence.js";
import type { LoopState } from "../../src/ivec/types.js";

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

  it("writeJSON + readState roundtrip", () => {
    const dataDir = makeTmpDir();
    try {
      const runPath = initRunDirectory(dataDir, "run-456");
      const state: LoopState = {
        runId: "run-456",
        userMessage: "hello",
        goal: "greet",
        approach: "direct",
        status: "running",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        facts: ["fact1"],
        uncertainties: [],
        completedSteps: [],
        runPath,
      };
      writeJSON(runPath, "state.json", state);
      const loaded = readState(runPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe("run-456");
      expect(loaded!.facts).toEqual(["fact1"]);
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
