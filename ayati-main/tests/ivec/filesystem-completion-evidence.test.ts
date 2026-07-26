import { describe, expect, it } from "vitest";
import { deriveFilesystemCompletionEvidence } from "../../src/ivec/agent-runner/filesystem-completion-evidence.js";
import type { ActToolCallRecord } from "../../src/ivec/types.js";

describe("filesystem completion evidence", () => {
  it("preserves deterministic slice metadata from a successful read", () => {
    const evidence = deriveFilesystemCompletionEvidence(readCall({
      filePath: "/tmp/source.ts",
      requestedPath: "/tmp/source.ts",
      mode: "slice",
      coverage: "partial",
      content: "40: function parse() {}",
      truncated: false,
      lineCount: 200,
      lineCountKnown: true,
      startLine: 40,
      endLine: 60,
    }), 2, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "path_state",
        path: "/tmp/source.ts",
        exists: true,
        operation: "read",
      }),
      expect.objectContaining({
        kind: "file_read",
        path: "/tmp/source.ts",
        mode: "slice",
        coverage: "partial",
        contentAvailable: true,
        truncated: false,
        lineCount: 200,
        lineCountKnown: true,
        startLine: 40,
        endLine: 60,
        step: 2,
        callId: "read-source",
      }),
    ]);
  });

  it("preserves exact search metadata and truncation", () => {
    const evidence = deriveFilesystemCompletionEvidence(readCall({
      filePath: "/tmp/source.ts",
      requestedPath: "/tmp/source.ts",
      mode: "search",
      coverage: "search_matches",
      content: "18: createParser",
      truncated: true,
      lineCount: 200,
      lineCountKnown: true,
      query: "createParser",
      matchCount: 12,
    }), 3, true);

    expect(evidence[1]).toMatchObject({
      kind: "file_read",
      mode: "search",
      coverage: "search_matches",
      truncated: true,
      query: "createParser",
      matchCount: 12,
    });
  });

  it("creates no read evidence when deterministic verification failed", () => {
    expect(deriveFilesystemCompletionEvidence(readCall({
      filePath: "/tmp/source.ts",
      requestedPath: "/tmp/source.ts",
      mode: "profile",
      coverage: "profile",
      content: "outline",
      truncated: false,
    }), 4, false)).toEqual([]);
  });

  it("records exact search completeness for a verified zero-match search", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "find-missing",
      tool: "find_files",
      input: { query: "missing-report.txt", roots: ["/workspace"] },
      output: "(no matches)",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_FOUND",
        message: "Found 0 matching files.",
        structuredContent: {
          query: "missing-report.txt",
          roots: ["/workspace"],
          matches: [],
          matchCount: 0,
          maxDepth: 10,
          maxResults: 500,
          includeHidden: false,
          capped: false,
          errors: [],
          errorCount: 0,
          depthLimitedDirectoryCount: 0,
          traversalComplete: true,
        },
      },
    }, 5, true);

    expect(evidence).toEqual([{
      kind: "file_search",
      query: "missing-report.txt",
      roots: ["/workspace"],
      matchCount: 0,
      maxDepth: 10,
      includeHidden: false,
      capped: false,
      errorCount: 0,
      depthLimitedDirectoryCount: 0,
      complete: true,
      change: "observed",
      tool: "find_files",
      step: 5,
      callId: "find-missing",
    }]);
  });
});

function readCall(result: Record<string, unknown>): ActToolCallRecord {
  return {
    callId: "read-source",
    tool: "read_files",
    input: {
      files: [{ path: "/tmp/source.ts" }],
    },
    output: "verified read",
    result: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "FILES_INSPECTED",
      message: "Inspected one file.",
      structuredContent: {
        results: [{
          ok: true,
          ...result,
        }],
      },
    },
  };
}
