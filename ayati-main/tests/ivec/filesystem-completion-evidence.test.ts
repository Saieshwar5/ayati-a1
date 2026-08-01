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

  it("preserves verified Unix permission metadata from path inspection", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "inspect-private-note",
      tool: "inspect_paths",
      input: { paths: ["/workspace/private-note.txt"] },
      output: "mode=0640 (rw-r-----)",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "PATHS_INSPECTED",
        message: "Inspected metadata for one path.",
        structuredContent: {
          results: [{
            requestedPath: "/workspace/private-note.txt",
            path: "/workspace/private-note.txt",
            exists: true,
            kind: "file",
            modeOctal: "0640",
            modeSymbolic: "rw-r-----",
          }],
        },
      },
    }, 5, true);

    expect(evidence).toEqual([expect.objectContaining({
      kind: "path_state",
      path: "/workspace/private-note.txt",
      operation: "inspect",
      modeOctal: "0640",
      modeSymbolic: "rw-r-----",
    })]);
  });

  it("does not preserve inconsistent Unix permission metadata", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "inspect-invalid-mode",
      tool: "inspect_paths",
      input: { paths: ["/workspace/private-note.txt"] },
      output: "invalid mode metadata",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "PATHS_INSPECTED",
        message: "Inspected metadata for one path.",
        structuredContent: {
          results: [{
            path: "/workspace/private-note.txt",
            exists: true,
            kind: "file",
            modeOctal: "0640",
            modeSymbolic: "rwxrwxrwx",
          }],
        },
      },
    }, 6, true);

    expect(evidence).toEqual([expect.not.objectContaining({
      modeOctal: expect.anything(),
      modeSymbolic: expect.anything(),
    })]);
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
          kind: "file",
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
      entryKind: "file",
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

  it("records an exact path observation for a directory-name match", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "find-cedar-directory",
      tool: "find_files",
      input: { query: "cedar", kind: "directory", roots: ["/workspace"] },
      output: "/workspace/cedar-studio",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_FOUND",
        message: "Found 1 matching path.",
        structuredContent: {
          query: "cedar",
          kind: "directory",
          roots: ["/workspace"],
          matches: [{
            absolutePath: "/workspace/cedar-studio",
            kind: "directory",
          }],
          matchCount: 1,
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
    }, 6, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "file_search",
        query: "cedar",
        entryKind: "directory",
        matchCount: 1,
      }),
      expect.objectContaining({
        kind: "path_state",
        path: "/workspace/cedar-studio",
        exists: true,
        actualKind: "directory",
        operation: "find",
      }),
    ]);
  });

  it("records exact search and path evidence for a symbolic-link match", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "find-latest-link",
      tool: "find_files",
      input: { query: "latest", kind: "symlink", roots: ["/workspace"] },
      output: "[symlink] /workspace/latest-letter.txt",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_FOUND",
        message: "Found 1 matching path.",
        structuredContent: {
          query: "latest",
          kind: "symlink",
          roots: ["/workspace"],
          matches: [{
            name: "latest-letter.txt",
            absolutePath: "/workspace/latest-letter.txt",
            kind: "symlink",
          }],
          matchCount: 1,
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
    }, 7, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "file_search",
        query: "latest",
        entryKind: "symlink",
        matchCount: 1,
      }),
      expect.objectContaining({
        kind: "path_state",
        path: "/workspace/latest-letter.txt",
        exists: true,
        actualKind: "symlink",
        operation: "find",
      }),
    ]);
  });

  it("records one verified positive content-search match per file", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "search-amber-marsh",
      tool: "search_in_files",
      input: { query: "Amber Marsh", roots: ["/workspace"] },
      output: "/workspace/letter.txt:2",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_SEARCHED",
        message: "Found a matching file.",
        structuredContent: {
          query: "Amber Marsh",
          roots: ["/workspace"],
          resultMode: "paths",
          matchedFileCount: 1,
          returnedMatchCount: 2,
          caseSensitive: false,
          matches: [
            {
              filePath: "/workspace/letter.txt",
              kind: "file",
              line: 2,
              before: [],
              match: "Amber Marsh sent the letter",
              after: [],
            },
            {
              filePath: "/workspace/letter.txt",
              kind: "file",
              line: 8,
              before: [],
              match: "Reply to Amber Marsh",
              after: [],
            },
          ],
        },
      },
    }, 6, true);

    expect(evidence).toEqual([{
      kind: "file_search_match",
      path: "/workspace/letter.txt",
      query: "Amber Marsh",
      line: 2,
      caseSensitive: false,
      actualKind: "file",
      change: "observed",
      tool: "search_in_files",
      step: 6,
      callId: "search-amber-marsh",
    }]);
  });

  it("rejects positive search evidence whose returned line does not contain the query", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "search-invalid",
      tool: "search_in_files",
      input: { query: "Amber Marsh", roots: ["/workspace"] },
      output: "/workspace/letter.txt:2",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_SEARCHED",
        message: "Found a matching file.",
        structuredContent: {
          query: "Amber Marsh",
          resultMode: "paths",
          matchedFileCount: 1,
          returnedMatchCount: 1,
          caseSensitive: false,
          matches: [{
            filePath: "/workspace/letter.txt",
            kind: "file",
            line: 2,
            before: [],
            match: "A different sender",
            after: [],
          }],
        },
      },
    }, 7, true);

    expect(evidence).toEqual([]);
  });

  it("records conclusive zero-match evidence from an exhaustive ordinary content search", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "search-missing-pool-code",
      tool: "search_in_files",
      input: {
        query: "swimming pool access code",
        roots: ["/workspace/reference"],
      },
      output: "No matches found.",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_SEARCHED",
        message: "Search completed without matches.",
        structuredContent: {
          query: "swimming pool access code",
          roots: ["/workspace/reference"],
          resultMode: "paths",
          matchedFileCount: 0,
          returnedMatchCount: 0,
          totalMatchCount: 0,
          minimumMatchCount: 0,
          countComplete: true,
          hasMore: false,
          countUnit: "occurrences",
          capped: false,
          matches: [],
          maxDepth: 10,
          includeHidden: false,
          caseSensitive: false,
          skippedLargeFiles: 0,
        },
      },
    }, 8, true);

    expect(evidence).toEqual([{
      kind: "file_search_count",
      query: "swimming pool access code",
      roots: ["/workspace/reference"],
      maxDepth: 10,
      includeHidden: false,
      caseSensitive: false,
      returnedMatchCount: 0,
      totalMatchCount: 0,
      countComplete: true,
      hasMore: false,
      countUnit: "occurrences",
      change: "observed",
      tool: "search_in_files",
      step: 8,
      callId: "search-missing-pool-code",
    }]);
  });

  it("records a positive exact count only from complete count-mode evidence", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "count-handbook-phrase",
      tool: "search_in_files",
      input: {
        query: "Routine Greenbridge maintenance cycle",
        roots: ["/workspace/reference"],
        resultMode: "count",
      },
      output: "2196 occurrences",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_SEARCHED",
        message: "Counted matching occurrences.",
        structuredContent: {
          query: "Routine Greenbridge maintenance cycle",
          roots: ["/workspace/reference"],
          resultMode: "count",
          matchedFileCount: 1,
          returnedMatchCount: 0,
          totalMatchCount: 2_196,
          minimumMatchCount: 2_196,
          countComplete: true,
          hasMore: false,
          countUnit: "occurrences",
          capped: false,
          matches: [],
          maxDepth: 10,
          includeHidden: false,
          caseSensitive: false,
          skippedLargeFiles: 0,
        },
      },
    }, 8, true);

    expect(evidence).toEqual([{
      kind: "file_search_count",
      query: "Routine Greenbridge maintenance cycle",
      roots: ["/workspace/reference"],
      maxDepth: 10,
      includeHidden: false,
      caseSensitive: false,
      returnedMatchCount: 0,
      totalMatchCount: 2_196,
      countComplete: true,
      hasMore: false,
      countUnit: "occurrences",
      change: "observed",
      tool: "search_in_files",
      step: 8,
      callId: "count-handbook-phrase",
    }]);
  });

  it("rejects incomplete count-mode evidence", () => {
    const evidence = deriveFilesystemCompletionEvidence({
      callId: "count-incomplete",
      tool: "search_in_files",
      input: { query: "needle", roots: ["/workspace"], resultMode: "count" },
      output: "incomplete count",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_SEARCHED",
        message: "Count incomplete.",
        structuredContent: {
          query: "needle",
          roots: ["/workspace"],
          resultMode: "count",
          returnedMatchCount: 0,
          totalMatchCount: null,
          minimumMatchCount: 3,
          countComplete: false,
          hasMore: true,
          countUnit: "occurrences",
          capped: false,
          matches: [],
          maxDepth: 10,
          includeHidden: false,
          caseSensitive: false,
          skippedLargeFiles: 1,
        },
      },
    }, 9, true);

    expect(evidence).toEqual([]);
  });

  it("distinguishes changed and unchanged desired-state write outcomes", () => {
    const evidence = deriveFilesystemCompletionEvidence(writeCall([
      {
        path: "/workspace/site/index.html",
        status: "created",
        sizeBytes: 10,
        sha256: "created-hash",
      },
      {
        path: "/workspace/site/styles.css",
        status: "unchanged",
        sizeBytes: 20,
        sha256: "unchanged-hash",
      },
    ]), 6, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        kind: "path_state",
        path: "/workspace/site/index.html",
        exists: true,
        change: "mutated",
        operation: "write",
      }),
      expect.objectContaining({
        kind: "path_state",
        path: "/workspace/site/styles.css",
        exists: true,
        change: "observed",
        operation: "write",
      }),
    ]);
  });

  it("carries targeted verifier transitions into durable mutation evidence", () => {
    const call = writeCall([{
      path: "/workspace/site/index.html",
      status: "replaced",
      sizeBytes: 12,
      sha256: "after-hash",
    }]);
    call.meta = {
      filesystemMutationVerification: {
        verified: true,
        targets: [{
          path: "/workspace/site/index.html",
          role: "write",
          before: "file",
          after: "file",
          beforeSha256: "before-hash",
          afterSha256: "after-hash",
        }],
      },
    };

    expect(deriveFilesystemCompletionEvidence(call, 7, true)).toEqual([
      expect.objectContaining({
        kind: "path_state",
        beforeKind: "file",
        afterKind: "file",
        beforeSha256: "before-hash",
        afterSha256: "after-hash",
      }),
    ]);
  });

  it("does not create completion evidence for a failed write entry", () => {
    const evidence = deriveFilesystemCompletionEvidence(writeCall([
      {
        path: "/workspace/site/index.html",
        status: "failed",
        sizeBytes: 10,
        sha256: "desired-hash",
      },
    ]), 7, true);

    expect(evidence).toEqual([]);
  });

  it("distinguishes created and already-existing directories", () => {
    const created = deriveFilesystemCompletionEvidence(mutationCall(
      "create_directory",
      {
        dirPath: "/workspace/site",
        requestedPath: "/workspace/site",
        status: "created",
      },
    ), 8, true);
    const existing = deriveFilesystemCompletionEvidence(mutationCall(
      "create_directory",
      {
        dirPath: "/workspace/site",
        requestedPath: "/workspace/site",
        status: "already_exists",
      },
    ), 9, true);

    expect(created).toEqual([
      expect.objectContaining({
        path: "/workspace/site",
        operation: "create",
        change: "mutated",
      }),
    ]);
    expect(existing).toEqual([
      expect.objectContaining({
        path: "/workspace/site",
        operation: "inspect",
        change: "observed",
      }),
    ]);
  });

  it("records a copy source as observed and its destination as created", () => {
    const evidence = deriveFilesystemCompletionEvidence(mutationCall("copy", {
      source: "/inputs/logo-link",
      destination: "/workspace/site/logo-link",
      kind: "symlink",
      status: "copied",
    }), 10, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        path: "/inputs/logo-link",
        exists: true,
        actualKind: "symlink",
        operation: "inspect",
        change: "observed",
      }),
      expect.objectContaining({
        path: "/workspace/site/logo-link",
        exists: true,
        actualKind: "symlink",
        operation: "copy",
        change: "mutated",
      }),
    ]);
  });

  it("records both changed and already-current permission outcomes", () => {
    const evidence = deriveFilesystemCompletionEvidence(mutationCall(
      "set_permissions",
      {
        files: [
          {
            path: "/workspace/site/run.sh",
            mode: "755",
            status: "changed",
          },
          {
            path: "/workspace/site/readme.txt",
            mode: "644",
            status: "unchanged",
          },
        ],
      },
    ), 11, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        path: "/workspace/site/run.sh",
        operation: "permissions",
        change: "mutated",
      }),
      expect.objectContaining({
        path: "/workspace/site/readme.txt",
        operation: "permissions",
        change: "observed",
      }),
    ]);
  });

  it("records an already-absent delete as observation instead of deletion", () => {
    const evidence = deriveFilesystemCompletionEvidence(mutationCall("delete", {
      targetPath: "/workspace/site/old.txt",
      status: "already_absent",
      deleted: false,
    }), 12, true);

    expect(evidence).toEqual([
      expect.objectContaining({
        path: "/workspace/site/old.txt",
        exists: false,
        operation: "inspect",
        change: "observed",
      }),
    ]);
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

function writeCall(files: Record<string, unknown>[]): ActToolCallRecord {
  return {
    callId: "write-site",
    tool: "write_files",
    input: {
      files: files.map((file) => ({
        path: file["path"],
        content: "omitted from evidence",
      })),
    },
    output: "desired state applied",
    result: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "FILES_APPLIED",
      message: "Requested content is current.",
      structuredContent: {
        files,
      },
    },
  };
}

function mutationCall(
  tool: string,
  structuredContent: Record<string, unknown>,
): ActToolCallRecord {
  return {
    callId: `call-${tool}`,
    tool,
    input: {},
    output: "mutation completed",
    result: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "MUTATION_COMPLETED",
      message: "Mutation completed.",
      structuredContent,
    },
  };
}
