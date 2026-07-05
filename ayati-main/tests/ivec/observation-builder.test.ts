import { describe, expect, it } from "vitest";
import { buildToolObservation } from "../../src/ivec/agent-runner/observation-builder.js";

describe("tool output observations", () => {
  it("creates an observation for decision-context tools without writing raw output files", async () => {
    const result = await buildToolObservation({
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
    expect(result.rawOutputChars).toBeGreaterThan(0);
  });

  it("does not create observations for operation-only tools", async () => {
    const result = await buildToolObservation({
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
  });

  it("prefers structured compact observations over raw output", async () => {
    const hugeOutput = Array.from({ length: 200 }, (_, index) => `raw line ${index + 1}`).join("\n");
    const result = await buildToolObservation({
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
  });

  it("marks very large previews as evidence-only hot context", async () => {
    const hugeOutput = Array.from({ length: 30_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = await buildToolObservation({
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
    expect(result.rawOutputChars).toBe(hugeOutput.length);
    expect(result.outputTruncated).toBe(true);
  });
});
