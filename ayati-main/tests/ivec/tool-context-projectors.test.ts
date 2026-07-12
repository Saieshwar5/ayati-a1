import { describe, expect, it } from "vitest";
import type { PromptRunToolCallContext } from "../../src/ivec/agent-runner/run-tool-call-context.js";
import { buildToolProjectionMetadata } from "../../src/ivec/agent-runner/tool-context-projectors/metadata.js";
import { projectToolCallForPressure } from "../../src/ivec/agent-runner/tool-context-projectors/registry.js";

describe("tool context projectors", () => {
  it("removes written file contents while retaining paths and result metadata", () => {
    const projection = projectToolCallForPressure(call({
      tool: "write_files",
      input: {
        files: [{ path: "src/new.ts", content: "x".repeat(20_000), baseSha256: "old-hash" }],
        createDirs: true,
      },
      projectionMetadata: {
        filesWritten: 1,
        totalBytes: 20_000,
        files: [{ filePath: "src/new.ts", bytesWritten: 20_000, sha256: "new-hash" }],
      },
    }), "summary");

    expect(projection.projectorId).toBe("filesystem_write_v1");
    expect(projection.call.input).toEqual({
      createDirs: true,
      files: [{ path: "src/new.ts", baseSha256: "old-hash" }],
    });
    expect(projection.call.purpose).toBe("Inspect the source file before editing it.");
    expect(projection.call.summary).toContain("new-hash");
    expect(JSON.stringify(projection.call)).not.toContain("x".repeat(1_000));
  });

  it("uses the test/build projector before the generic shell projector", () => {
    const projection = projectToolCallForPressure(call({
      tool: "shell",
      input: { cmd: "pnpm --filter ayati-main test", workdir: "/workspace" },
      output: `test output\n${"middle\n".repeat(1_000)}failure: expected 60K received 70K`,
      projectionMetadata: {
        command: "pnpm --filter ayati-main test",
        cwd: "/workspace",
        exitCode: 1,
        stderrPreview: "failure: expected 60K received 70K",
      },
    }), "preview");

    expect(projection.projectorId).toBe("test_build_v1");
    expect(projection.call.summary).toContain("test_or_build");
    expect(projection.call.outputPreview).toContain("failure: expected 60K received 70K");
  });

  it("uses structured search metadata and keeps exact query inputs", () => {
    const projection = projectToolCallForPressure(call({
      tool: "search_in_files",
      input: { query: "ContextBudget", roots: ["src"], maxResults: 20 },
      projectionMetadata: {
        query: "ContextBudget",
        matchedFileCount: 2,
        matchCount: 4,
        capped: false,
        matches: [{ filePath: "src/context.ts", line: 10, match: "ContextBudget" }],
      },
    }), "preview");

    expect(projection.projectorId).toBe("filesystem_search_v1");
    expect(projection.call.input).toEqual({ query: "ContextBudget", roots: ["src"], maxResults: 20 });
    expect(projection.call.summary).toContain("matchedFileCount");
  });

  it("uses the shell projector for non-test commands", () => {
    const projection = projectToolCallForPressure(call({
      tool: "shell",
      input: { cmd: "git status --short", workdir: "/workspace" },
      projectionMetadata: { exitCode: 0, durationMs: 12 },
    }), "summary");

    expect(projection.projectorId).toBe("shell_v1");
    expect(projection.call.summary).toContain("git status --short");
  });

  it("keeps structured file metadata while dropping duplicate file content", () => {
    const metadata = buildToolProjectionMetadata("read_files", {
      results: [{
        requestedPath: "src/a.ts",
        filePath: "src/a.ts",
        content: "private source content",
        lineCount: 40,
        sha256: "file-hash",
      }],
      observation: { blocks: ["duplicate"] },
    });

    expect(metadata).toEqual({
      results: [{
        requestedPath: "src/a.ts",
        filePath: "src/a.ts",
        lineCount: 40,
        sha256: "file-hash",
      }],
    });
  });

  it("falls back to the deterministic generic projector for unknown tools", () => {
    const projection = projectToolCallForPressure(call({ tool: "custom_tool" }), "summary");

    expect(projection.projectorId).toBe("generic_v1");
    expect(projection.call.mode).toBe("summary");
  });

  it("preserves Git-context identifiers and bounded result metadata", () => {
    const projection = projectToolCallForPressure(call({
      tool: "git_context_read_run_step",
      input: { runId: "run-7", step: 4, callId: "call-4", internalCache: "omit" },
      projectionMetadata: { runId: "run-7", step: 4, summary: "Verified the build." },
    }), "summary");

    expect(projection.projectorId).toBe("git_context_v1");
    expect(projection.call.input).toEqual({ runId: "run-7", step: 4, callId: "call-4" });
    expect(projection.call.summary).toContain("Verified the build.");
  });
});

function call(overrides: Partial<PromptRunToolCallContext> = {}): PromptRunToolCallContext {
  return {
    step: 1,
    callId: "call-1",
    tool: "read_files",
    purpose: "Inspect the source file before editing it.",
    input: { files: [{ path: "src/a.ts" }] },
    status: "success",
    retention: "next_step",
    mode: "full",
    output: "tool output",
    stepRef: { runId: "run-1", step: 1, callId: "call-1" },
    ...overrides,
  };
}
