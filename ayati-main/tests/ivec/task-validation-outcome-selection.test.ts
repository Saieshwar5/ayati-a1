import { describe, expect, it } from "vitest";
import { buildCurrentRunVerificationIndex } from "../../src/ivec/agent-runner/run-verification-index.js";
import { resolveValidationOutcomeRefs } from "../../src/ivec/agent-runner/task-validation-outcome-selection.js";
import { prepareTaskValidationTransition } from "../../src/ivec/agent-runner/task-validation-transition.js";
import type {
  FilesystemCompletionEvidence,
  RunToolCallContext,
} from "../../src/ivec/types.js";

const RUN_ID = "RUN-VALIDATION-SELECTION";

describe("task validation outcome selection", () => {
  it("keeps runtime-owned Unix permission metadata on an inspected path check", () => {
    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [verifiedCall(1, "inspect_paths", [{
        ...pathEvidence("/workspace/private-note.txt", 1, "observed", "inspect"),
        modeOctal: "0640",
        modeSymbolic: "rw-r-----",
      }])],
    });
    const outcomeRef = `run:${RUN_ID}:step:1:call:call-1:outcome:0`;

    expect(resolveValidationOutcomeRefs(index, [outcomeRef])).toEqual({
      ok: true,
      checks: [{
        outcomeRef,
        kind: "path.exists",
        subject: "/workspace/private-note.txt",
        expectedKind: "file",
        modeOctal: "0640",
        modeSymbolic: "rw-r-----",
      }],
    });
  });

  it("resolves an exact current completion reference into a runtime-owned check", () => {
    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [verifiedCall(1, "read_files", [{
        kind: "file_read",
        path: "/workspace/source.ts",
        requestedPath: "/workspace/source.ts",
        coverage: "partial",
        contentAvailable: true,
        change: "observed",
        tool: "read_files",
        step: 1,
        callId: "call-1",
        mode: "slice",
        truncated: false,
        startLine: 10,
        endLine: 20,
      }])],
    });
    const outcomeRef = `run:${RUN_ID}:step:1:call:call-1:outcome:0`;

    expect(resolveValidationOutcomeRefs(index, [outcomeRef])).toEqual({
      ok: true,
      checks: [{
        outcomeRef,
        kind: "file.read_scope_satisfied",
        subject: "/workspace/source.ts",
        expectedKind: "file",
        readScope: {
          mode: "slice",
          startLine: 10,
          endLine: 20,
        },
      }],
    });
  });

  it("resolves a positive content-search result without requiring a file read", () => {
    const index = buildCurrentRunVerificationIndex({
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
    const outcomeRef = `run:${RUN_ID}:step:1:call:call-1:outcome:0`;

    expect(resolveValidationOutcomeRefs(index, [outcomeRef])).toEqual({
      ok: true,
      checks: [{
        outcomeRef,
        kind: "file.search_match",
        subject: "/workspace/letters/amber.txt",
        expectedKind: "file",
        searchMatch: {
          query: "Amber Marsh",
          line: 12,
          caseSensitive: false,
        },
      }],
    });
  });

  it("resolves only a complete exact content count into validation", () => {
    const index = buildCurrentRunVerificationIndex({
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
    const outcomeRef = `run:${RUN_ID}:step:1:call:call-1:outcome:0`;

    expect(resolveValidationOutcomeRefs(index, [outcomeRef])).toEqual({
      ok: true,
      checks: [{
        outcomeRef,
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
      }],
    });
  });

  it("rejects fabricated and cross-run references", () => {
    const index = buildCurrentRunVerificationIndex({ runId: RUN_ID, calls: [] });

    expect(resolveValidationOutcomeRefs(index, ["invented-outcome"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("No current-run completion outcome"),
    });
    expect(resolveValidationOutcomeRefs(index, [
      "run:RUN-OTHER:step:1:call:call-1:outcome:0",
    ])).toMatchObject({
      ok: false,
      message: expect.stringContaining("No current-run completion outcome"),
    });
  });

  it("rejects routing evidence even when its exact reference exists", () => {
    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [verifiedCall(1, "git_context_find_workstreams", [pathEvidence(
        "/workspace/context.md",
        1,
        "observed",
        "inspect",
      )])],
    });

    expect(resolveValidationOutcomeRefs(index, [
      `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
    ])).toMatchObject({
      ok: false,
      message: expect.stringContaining("routing evidence"),
    });
  });

  it("rejects supporting evidence even when its exact reference exists", () => {
    const call = verifiedCall(1, "read_files", []);
    call.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "The tool returned a supporting observation.",
      checks: [],
      facts: [{
        kind: "diagnostic_note",
        message: "A useful detail that is not registered as completion proof.",
        subject: "diagnostic",
      }],
    };
    const index = buildCurrentRunVerificationIndex({ runId: RUN_ID, calls: [call] });

    expect(resolveValidationOutcomeRefs(index, [
      `run:${RUN_ID}:step:1:call:call-1:fact:0`,
    ])).toMatchObject({
      ok: false,
      message: expect.stringContaining("supporting evidence"),
    });
  });

  it("rejects a stale reference after a later mutation invalidates it", () => {
    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [
        verifiedCall(1, "read_files", [{
          kind: "file_read",
          path: "/workspace/report.md",
          requestedPath: "/workspace/report.md",
          coverage: "complete",
          contentAvailable: true,
          change: "observed",
          tool: "read_files",
          step: 1,
          callId: "call-1",
          mode: "full",
          truncated: false,
        }]),
        verifiedCall(2, "write_files", [pathEvidence(
          "/workspace/report.md",
          2,
          "mutated",
          "write",
        )]),
      ],
    });

    expect(resolveValidationOutcomeRefs(index, [
      `run:${RUN_ID}:step:1:call:call-1:outcome:0`,
    ])).toMatchObject({
      ok: false,
      message: expect.stringContaining("stale"),
    });
  });

  it("accepts resource metadata only for a selected filesystem subject", () => {
    const calls = [verifiedCall(1, "write_files", [pathEvidence(
      "/workspace/site/index.html",
      1,
      "mutated",
      "write",
    )])];
    const outcomeRef = `run:${RUN_ID}:step:1:call:call-1:outcome:0`;
    const request = {
      to: "validation" as const,
      purpose: "Validate the created website file.",
      capabilities: ["task:validation"],
      outcomeRefs: [outcomeRef],
      resourceMetadata: [{
        path: "/workspace/site/index.html",
        displayName: "Homepage",
        description: "Primary page for the site.",
        aliases: ["home page"],
      }],
    };

    expect(prepareTaskValidationTransition({ runId: RUN_ID, calls, request }))
      .toMatchObject({
        ok: true,
        request: {
          validationChecks: [{
            outcomeRef,
            kind: "file.written",
            subject: "/workspace/site/index.html",
          }],
        },
      });
    expect(prepareTaskValidationTransition({
      runId: RUN_ID,
      calls,
      request: {
        ...request,
        resourceMetadata: [{
          ...request.resourceMetadata[0]!,
          path: "/workspace/site/other.html",
        }],
      },
    })).toMatchObject({
      ok: false,
      repair: {
        code: "MODE_INPUT_INVALID",
        blockedTargets: ["/workspace/site/other.html"],
      },
    });
  });
});

function verifiedCall(
  step: number,
  tool: string,
  completionEvidence: FilesystemCompletionEvidence[],
): RunToolCallContext {
  return {
    step,
    callId: `call-${step}`,
    tool,
    input: {},
    status: "success",
    output: "verified",
    verificationPassed: true,
    completionEvidence,
  };
}

function pathEvidence(
  path: string,
  step: number,
  change: "observed" | "mutated",
  operation: Extract<FilesystemCompletionEvidence, { kind: "path_state" }>["operation"],
): FilesystemCompletionEvidence {
  return {
    kind: "path_state",
    path,
    exists: true,
    actualKind: "file",
    change,
    operation,
    tool: operation === "write" ? "write_files" : "inspect_paths",
    step,
    callId: `call-${step}`,
  };
}
