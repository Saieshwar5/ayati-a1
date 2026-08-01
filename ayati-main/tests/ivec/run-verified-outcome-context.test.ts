import { describe, expect, it } from "vitest";
import { buildPromptVerifiedOutcomes } from "../../src/ivec/agent-runner/run-verified-outcome-context.js";
import type {
  FilesystemCompletionEvidence,
  RunToolCallContext,
} from "../../src/ivec/types.js";

const RUN_ID = "RUN-PROMPT-OUTCOMES";

describe("run verified-outcome prompt context", () => {
  it("projects exact inspected Unix permissions for validation", () => {
    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [verifiedCall(1, "inspect_paths", [{
        kind: "path_state",
        path: "/workspace/private-note.txt",
        requestedPath: "/workspace/private-note.txt",
        exists: true,
        actualKind: "file",
        change: "observed",
        operation: "inspect",
        modeOctal: "0640",
        modeSymbolic: "rw-r-----",
        tool: "inspect_paths",
        step: 1,
        callId: "call-1",
      }])],
    });

    expect(outcomes).toEqual([{
      outcomeRef: `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
      kind: "path.exists",
      subject: "/workspace/private-note.txt",
      actualKind: "file",
      modeOctal: "0640",
      modeSymbolic: "rw-r-----",
      source: {
        step: 1,
        callId: "call-1",
        tool: "inspect_paths",
      },
    }]);
  });

  it("projects an exact no-match search scope for validation", () => {
    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [verifiedCall(1, "find_files", [{
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
        step: 1,
        callId: "call-1",
      }])],
    });

    expect(outcomes).toEqual([{
      outcomeRef: `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
        entryKind: "file",
      },
      source: {
        step: 1,
        callId: "call-1",
        tool: "find_files",
      },
    }]);
  });

  it("projects a positive content-search match without exposing matched text", () => {
    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [verifiedCall(1, "search_in_files", [{
        kind: "file_search_match",
        path: "/workspace/letters/amber.txt",
        query: "Amber Marsh",
        line: 12,
        caseSensitive: false,
        actualKind: "file",
        change: "observed",
        tool: "search_in_files",
        step: 1,
        callId: "call-1",
      }])],
    });

    expect(outcomes).toEqual([{
      outcomeRef: `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
      kind: "file.search_match",
      subject: "/workspace/letters/amber.txt",
      actualKind: "file",
      searchMatch: {
        query: "Amber Marsh",
        line: 12,
        caseSensitive: false,
      },
      source: {
        step: 1,
        callId: "call-1",
        tool: "search_in_files",
      },
    }]);
    expect(JSON.stringify(outcomes)).not.toContain("sent the letter");
  });

  it("projects an exact complete count without matching text", () => {
    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [verifiedCall(1, "search_in_files", [{
        kind: "file_search_count",
        query: "needle",
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
        caseSensitive: false,
        returnedMatchCount: 0,
        totalMatchCount: 42,
        countComplete: true,
        hasMore: false,
        countUnit: "occurrences",
        change: "observed",
        tool: "search_in_files",
        step: 1,
        callId: "call-1",
      }])],
    });

    expect(outcomes).toEqual([{
      outcomeRef: `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
      kind: "file.search_count",
      subject: "needle",
      searchCount: {
        query: "needle",
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
        caseSensitive: false,
        countUnit: "occurrences",
        totalMatchCount: 42,
      },
      source: {
        step: 1,
        callId: "call-1",
        tool: "search_in_files",
      },
    }]);
  });

  it("projects validation-ready write and scoped-read proofs", () => {
    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [
        verifiedCall(1, "write_files", [pathEvidence(
          "/workspace/src/config.ts",
          true,
          "file",
          1,
          "write",
          "mutated",
        )]),
        verifiedCall(2, "read_files", [{
          kind: "file_read",
          path: "/workspace/src/parser.ts",
          requestedPath: "/workspace/src/parser.ts",
          coverage: "partial",
          contentAvailable: true,
          change: "observed",
          tool: "read_files",
          step: 2,
          callId: "call-2",
          mode: "slice",
          truncated: false,
          startLine: 10,
          endLine: 20,
        }]),
      ],
    });

    expect(outcomes).toEqual([
      {
        outcomeRef: `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
        kind: "file.written",
        subject: "/workspace/src/config.ts",
        actualKind: "file",
        source: {
          step: 1,
          callId: "call-1",
          tool: "write_files",
        },
      },
      {
        outcomeRef: `run:${RUN_ID}:step:2:call:call-2:outcome:1`,
        kind: "file.read_scope_satisfied",
        subject: "/workspace/src/parser.ts",
        actualKind: "file",
        readScope: {
          mode: "slice",
          startLine: 10,
          endLine: 20,
        },
        source: {
          step: 2,
          callId: "call-2",
          tool: "read_files",
        },
      },
    ]);
  });

  it("omits failed, routing, supporting, and stale outcomes", () => {
    const read = verifiedCall(1, "read_files", [{
      kind: "file_read",
      path: "/workspace/report.txt",
      requestedPath: "/workspace/report.txt",
      coverage: "complete",
      contentAvailable: true,
      change: "observed",
      tool: "read_files",
      step: 1,
      callId: "call-1",
      mode: "full",
      truncated: false,
    }]);
    const write = verifiedCall(2, "write_files", [pathEvidence(
      "/workspace/report.txt",
      true,
      "file",
      2,
      "write",
      "mutated",
    )]);
    const failed = verifiedCall(3, "write_files", [pathEvidence(
      "/workspace/failed.txt",
      true,
      "file",
      3,
      "write",
      "mutated",
    )]);
    failed.status = "failed";
    failed.verificationPassed = false;
    const routing = verifiedCall(4, "git_context_find_workstreams", [pathEvidence(
      "/workspace/routing.txt",
      true,
      "file",
      4,
    )]);

    const outcomes = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [read, write, failed, routing],
    });

    expect(outcomes).toEqual([
      expect.objectContaining({
        kind: "file.written",
        subject: "/workspace/report.txt",
        source: expect.objectContaining({ step: 2 }),
      }),
    ]);
  });

  it("keeps an earlier outcome reference stable when later evidence is appended", () => {
    const firstCall = verifiedCall(1, "read_files", [
      pathEvidence("/workspace/report.txt", true, "file", 1, "read", "observed"),
      {
        kind: "file_read",
        path: "/workspace/report.txt",
        requestedPath: "/workspace/report.txt",
        coverage: "complete",
        contentAvailable: true,
        change: "observed",
        tool: "read_files",
        step: 1,
        callId: "call-1",
        mode: "full",
        truncated: false,
      },
    ]);
    const initial = buildPromptVerifiedOutcomes({ runId: RUN_ID, calls: [firstCall] });
    const appended = buildPromptVerifiedOutcomes({
      runId: RUN_ID,
      calls: [
        firstCall,
        verifiedCall(2, "write_files", [pathEvidence(
          "/workspace/other.txt",
          true,
          "file",
          2,
          "write",
          "mutated",
        )]),
      ],
    });

    expect(initial[1]?.outcomeRef).toBe(
      `run:${RUN_ID}:step:1:call:call-1:outcome:1`,
    );
    expect(appended.find((outcome) => (
      outcome.subject === "/workspace/report.txt"
      && outcome.kind === "file.read_complete"
    ))?.outcomeRef)
      .toBe(initial[1]?.outcomeRef);
  });
});

function verifiedCall(
  step: number,
  tool: string,
  completionEvidence: FilesystemCompletionEvidence[],
): RunToolCallContext {
  const callId = `call-${step}`;
  return {
    step,
    callId,
    tool,
    input: {},
    status: "success",
    output: "verified",
    stepRef: {
      runId: RUN_ID,
      step,
      callId,
    },
    verificationPassed: true,
    completionEvidence,
  };
}

function pathEvidence(
  path: string,
  exists: boolean,
  actualKind: "file" | "directory",
  step: number,
  operation: Extract<FilesystemCompletionEvidence, { kind: "path_state" }>["operation"] = "inspect",
  change: "observed" | "mutated" = "observed",
): FilesystemCompletionEvidence {
  return {
    kind: "path_state",
    path,
    exists,
    actualKind,
    change,
    operation,
    tool: operation === "write" ? "write_files" : "inspect_paths",
    step,
    callId: `call-${step}`,
  };
}
