import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolObservation } from "../../src/ivec/agent-runner/observation-builder.js";
import { createEvidenceTools } from "../../src/ivec/agent-runner/evidence-tools.js";
import type { LoopState } from "../../src/ivec/types.js";

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
      expect(result.observation?.content).toContain("Useful compact summary");
      expect(result.observation?.content).toContain("only useful context");
      expect(result.observation?.content).not.toContain("raw line 199");
      expect(result.rawOutputChars).toBe(hugeOutput.length);
      expect(readFileSync(join(runPath, "raw", "002-call_2-read_file-output.txt"), "utf-8")).toContain("raw line 199");
    } finally {
      cleanup(runPath);
    }
  });

  it("creates evidence-tool observations without replacing the source evidence ref", async () => {
    const runPath = makeTmpDir();
    try {
      const result = await buildToolObservation({
        runPath,
        stepNumber: 3,
        call: {
          id: "call_1",
          tool: "evidence_read_lines",
          input: {},
          dependsOn: [],
          purpose: "Read saved process list lines",
        },
        record: {
          callId: "call_1",
          tool: "evidence_read_lines",
          input: {},
          output: "PID USER %MEM RSS COMMAND\n100 sai 5.3 416820 chromium",
          result: {
            transportOk: true,
            operationStatus: "succeeded",
            code: "EVIDENCE_LINES_READ",
            message: "Read evidence lines 1-2 from evidence://ev_001_call_2.",
            structuredContent: {
              evidenceRef: "evidence://ev_001_call_2",
              rawOutputPath: "raw/001-call_2-shell-output.txt",
              mode: "full",
              startLine: 1,
              endLine: 2,
              hasMore: false,
              lineCount: 2,
            },
          },
        },
      });

      expect(result.observation?.id).toBe("ctx_003_call_1");
      expect(result.observation?.purpose).toBe("Read saved process list lines");
      expect(result.observation?.evidenceRef).toBe("evidence://ev_001_call_2");
      expect(result.observation?.sourceEvidenceRef).toBe("evidence://ev_001_call_2");
      expect(result.observation?.rawOutputPath).toBe("raw/001-call_2-shell-output.txt");
      expect(result.evidenceRef).toBeUndefined();
    } finally {
      cleanup(runPath);
    }
  });

  it("searches saved evidence through run-scoped evidence tools", async () => {
    const runPath = makeTmpDir();
    try {
      const rawDir = join(runPath, "raw");
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, "001-call_1-shell-output.txt"), "line one\nTypeError: bad status\nline three", "utf-8");
      const state: LoopState = {
        runId: "r1",
        runClass: "task",
        userMessage: "debug",
        workState: {
          status: "not_done",
          summary: "",
          verifiedFacts: [],
          evidence: [],
          evidenceRefs: [{
            id: "ev_001_call_1",
            step: 1,
            callId: "call_1",
            tool: "shell",
            title: "shell output",
            ref: "evidence://ev_001_call_1",
            rawOutputPath: "raw/001-call_1-shell-output.txt",
            rawOutputChars: 40,
            lineCount: 3,
            truncated: false,
            access: ["search", "read_lines", "tail"],
          }],
        },
        status: "running",
        finalOutput: "",
        iteration: 1,
        maxIterations: 15,
        consecutiveFailures: 0,
        completedSteps: [],
        runPath,
        failureHistory: [],
      };

      const search = createEvidenceTools(state).find((tool) => tool.name === "evidence_search");
      const result = await search!.execute({ evidenceRef: "evidence://ev_001_call_1", query: "TypeError", contextLines: 1 });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("TypeError");
      expect(result.v2?.structuredContent).toMatchObject({
        evidenceRef: "evidence://ev_001_call_1",
        matchCount: 1,
      });
    } finally {
      cleanup(runPath);
    }
  });
});
