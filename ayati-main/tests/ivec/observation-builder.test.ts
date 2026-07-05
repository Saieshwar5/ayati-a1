import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolObservation } from "../../src/ivec/agent-runner/observation-builder.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-observation-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("tool output observations", () => {
  it("saves raw output and creates an observation for decision-context tools", async () => {
    const runPath = makeTmpDir();
    try {
      const result = await buildToolObservation({
        runPath,
        stepNumber: 1,
        call: {
          id: "call_1",
          tool: "shell",
          input: {},
          dependsOn: [],
        },
        record: {
          callId: "call_1",
          tool: "shell",
          input: {},
          output: "Mem: 7.4Gi total, 3.5Gi used, 3.8Gi available\nDisk: 447G available",
        },
      });

      expect(result.observation?.mode).toBe("full");
      expect(result.observation?.retention).toBe("next_step");
      expect(result.observation?.content).toContain("3.5Gi used");
      expect(result.evidenceRef?.ref).toBe("evidence://ev_001_call_1");
      expect(result.rawOutputPath).toBe("raw/001-call_1-shell-output.txt");
      expect(existsSync(join(runPath, "raw", "001-call_1-shell-output.txt"))).toBe(true);
      expect(readFileSync(join(runPath, "raw", "001-call_1-shell-output.txt"), "utf-8")).toContain("447G");
    } finally {
      cleanup(runPath);
    }
  });

  it("does not create observations for operation-only tools", async () => {
    const runPath = makeTmpDir();
    try {
      const result = await buildToolObservation({
        runPath,
        stepNumber: 1,
        call: {
          id: "call_1",
          tool: "write_files",
          input: {},
          dependsOn: [],
        },
        record: {
          callId: "call_1",
          tool: "write_files",
          input: {},
          output: JSON.stringify({ files: ["index.html"] }),
        },
      });

      expect(result.observation).toBeUndefined();
      expect(result.evidenceRef).toBeUndefined();
    } finally {
      cleanup(runPath);
    }
  });

  it("prefers structured compact observations over raw output", async () => {
    const runPath = makeTmpDir();
    try {
      const hugeOutput = Array.from({ length: 200 }, (_, index) => `raw line ${index + 1}`).join("\n");
      const result = await buildToolObservation({
        runPath,
        stepNumber: 2,
        call: {
          id: "call_2",
          tool: "read_file",
          input: {},
          dependsOn: [],
        },
        record: {
          callId: "call_2",
          tool: "read_file",
          input: {},
          output: "compact tool output",
          result: {
            transportOk: true,
            operationStatus: "succeeded",
            code: "FILE_INSPECTED",
            message: "Inspected file.",
            structuredContent: {
              observation: {
                mode: "focused",
                summary: "Useful compact summary.",
                stats: { lineCount: 200 },
                highlights: ["important symbol"],
                blocks: [{ title: "Relevant block", content: "only useful context", startLine: 10, endLine: 12 }],
                hasMore: true,
              },
            },
          },
        },
        rawOutput: hugeOutput,
      });

      expect(result.observation?.mode).toBe("focused");
      expect(result.observation?.retention).toBe("while_relevant");
      expect(result.observation?.content).toContain("Useful compact summary");
      expect(result.observation?.content).toContain("only useful context");
      expect(result.observation?.content).not.toContain("raw line 199");
      expect(result.rawOutputChars).toBe(hugeOutput.length);
      expect(readFileSync(join(runPath, "raw", "002-call_2-read_file-output.txt"), "utf-8")).toContain("raw line 199");
    } finally {
      cleanup(runPath);
    }
  });

  it("marks very large previews as evidence-only hot context", async () => {
    const runPath = makeTmpDir();
    try {
      const hugeOutput = Array.from({ length: 30_000 }, (_, index) => `line ${index + 1}`).join("\n");
      const result = await buildToolObservation({
        runPath,
        stepNumber: 4,
        call: {
          id: "call_1",
          tool: "shell",
          input: {},
          dependsOn: [],
        },
        record: {
          callId: "call_1",
          tool: "shell",
          input: {},
          output: hugeOutput,
        },
      });

      expect(result.observation?.mode).toBe("large_ref");
      expect(result.observation?.retention).toBe("evidence_only");
      expect(result.observation?.availableActions).toEqual(["search", "read_range", "inspect"]);
      expect(result.evidenceRef?.truncated).toBe(true);
      expect(result.evidenceRef?.access).toEqual(["raw"]);
    } finally {
      cleanup(runPath);
    }
  });
});
