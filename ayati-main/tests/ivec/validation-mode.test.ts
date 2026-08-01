import { describe, expect, it } from "vitest";
import {
  applyValidationModeEvidence,
  validationModePassed,
} from "../../src/ivec/agent-runner/validation-mode.js";
import { buildCurrentRunVerificationIndex } from "../../src/ivec/agent-runner/run-verification-index.js";
import type {
  ModeTransitionValidationCheck,
  VirtualModeState,
} from "../../src/ivec/agent-runner/virtual-mode.js";
import type {
  FilesystemCompletionEvidence,
  RunToolCallContext,
} from "../../src/ivec/types.js";

const RUN_ID = "RUN-CURRENT";

describe("validation mode", () => {
  it("passes a positive content-search match without reading the file", () => {
    const check: ModeTransitionValidationCheck = {
      kind: "file.search_match",
      subject: "/workspace/letters/amber.txt",
      expectedKind: "file",
      searchMatch: {
        query: "Amber Marsh",
        line: 12,
        caseSensitive: false,
      },
    };
    const mode = validationMode([check]);

    applyEvidence(mode, [evidenceCall(1, [{
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
    }])]);

    expect(validationModePassed(mode)).toBe(true);
    expect(mode.validation?.checks[0]).toMatchObject({
      status: "passed",
      actualKind: "file",
      tool: "search_in_files",
      message: expect.stringContaining("file-content match"),
    });
  });

  it("requires complete count evidence for an exact content count", () => {
    const check: ModeTransitionValidationCheck = {
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
    };
    const missing = validationMode([check]);
    applyEvidence(missing, []);
    expect(validationModePassed(missing)).toBe(false);

    const complete = validationMode([check]);
    applyEvidence(complete, [evidenceCall(1, [{
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
    }])]);

    expect(validationModePassed(complete)).toBe(true);
    expect(complete.validation?.checks[0]).toMatchObject({
      status: "passed",
      tool: "search_in_files",
      message: expect.stringContaining("complete file-content occurrence count"),
    });
  });

  it("passes a conclusive zero-match search without rerunning the search", () => {
    const check: ModeTransitionValidationCheck = {
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
        entryKind: "file",
      },
    };
    const mode = validationMode([check]);

    applyEvidence(mode, [evidenceCall(1, [{
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
    }])]);

    expect(validationModePassed(mode)).toBe(true);
    expect(mode.validation?.checks[0]).toMatchObject({
      status: "passed",
      tool: "find_files",
      message: expect.stringContaining("complete search with no matching files"),
      satisfiedBy: {
        step: 1,
        callId: "call-1",
        tool: "find_files",
      },
    });
  });

  it("passes important path outcomes from current-run deterministic proof", () => {
    const mode = validationMode([
      {
        kind: "path.exists",
        subject: "/tmp/site/index.html",
        expectedKind: "file",
      },
      {
        kind: "path.exists",
        subject: "/tmp/site/assets",
        expectedKind: "directory",
      },
    ]);

    applyEvidence(mode, [
      evidenceCall(1, [
        pathEvidence("/tmp/site/index.html", true, "file", 1),
        pathEvidence("/tmp/site/assets", true, "directory", 1),
      ]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "passed",
      checks: [
        {
          kind: "path.exists",
          subject: "/tmp/site/index.html",
          status: "passed",
          actualKind: "file",
          tool: "inspect_paths",
          satisfiedBy: {
            step: 1,
            callId: "call-1",
            tool: "inspect_paths",
            ref: `run:${RUN_ID}:step:1:call:call-1`,
          },
        },
        {
          kind: "path.exists",
          subject: "/tmp/site/assets",
          status: "passed",
          actualKind: "directory",
        },
      ],
    });
    expect(validationModePassed(mode)).toBe(true);
  });

  it("fails when the latest verified path state says the file is missing", () => {
    const mode = validationMode([{
      kind: "path.exists",
      subject: "/tmp/site/script.js",
      expectedKind: "file",
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [pathEvidence("/tmp/site/script.js", false, "file", 1)]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "failed",
      checks: [{
        status: "failed",
        message: "No verified current-run path.exists outcome exists for the exact subject /tmp/site/script.js.",
      }],
    });
    expect(validationModePassed(mode)).toBe(false);
  });

  it("passes a complete-read outcome without reading the file again", () => {
    const mode = validationMode([{
      kind: "file.read_complete",
      subject: "/tmp/requirements.md",
      expectedKind: "file",
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/requirements.md", "complete", 1)]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "passed",
      checks: [{
        status: "passed",
        actualKind: "file",
        tool: "read_files",
        message: "Confirmed an already-verified current-run complete file read.",
        satisfiedBy: {
          step: 1,
          callId: "call-1",
          tool: "read_files",
          ref: `run:${RUN_ID}:step:1:call:call-1`,
        },
      }],
    });
  });

  it("rejects partial, unverified, or metadata-only evidence for a complete read", () => {
    const check: ModeTransitionValidationCheck = {
      kind: "file.read_complete",
      subject: "/tmp/requirements.md",
      expectedKind: "file",
    };
    const partial = validationMode([check]);
    applyEvidence(partial, [
      evidenceCall(1, [readEvidence("/tmp/requirements.md", "partial", 1)]),
    ]);
    expect(partial.validation?.status).toBe("failed");

    const unverified = validationMode([check]);
    applyEvidence(unverified, [
      evidenceCall(1, [readEvidence("/tmp/requirements.md", "complete", 1)], false),
    ]);
    expect(unverified.validation?.status).toBe("failed");

    const metadataOnly = validationMode([check]);
    applyEvidence(metadataOnly, [
      evidenceCall(1, [pathEvidence("/tmp/requirements.md", true, "file", 1)]),
    ]);
    expect(metadataOnly.validation?.status).toBe("failed");
  });

  it("passes an untruncated slice that covers the required line range", () => {
    const mode = validationMode([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      expectedKind: "file",
      readScope: {
        mode: "slice",
        startLine: 100,
        endLine: 120,
      },
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "partial", 1, {
        mode: "slice",
        truncated: false,
        startLine: 95,
        endLine: 125,
        lineCount: 300,
        lineCountKnown: true,
      })]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "passed",
      checks: [{
        status: "passed",
        actualKind: "file",
        message: "Confirmed the requested bounded file-read scope from current-run proof.",
        satisfiedBy: {
          step: 1,
          callId: "call-1",
          tool: "read_files",
        },
      }],
    });
  });

  it("rejects an insufficient or output-truncated slice", () => {
    const check: ModeTransitionValidationCheck = {
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      readScope: {
        mode: "slice",
        startLine: 100,
        endLine: 120,
      },
    };
    const insufficient = validationMode([check]);
    applyEvidence(insufficient, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "partial", 1, {
        mode: "slice",
        truncated: false,
        startLine: 100,
        endLine: 115,
      })]),
    ]);
    expect(insufficient.validation?.status).toBe("failed");

    const truncated = validationMode([check]);
    applyEvidence(truncated, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "partial", 1, {
        mode: "slice",
        truncated: true,
        startLine: 100,
        endLine: 120,
      })]),
    ]);
    expect(truncated.validation?.status).toBe("failed");
  });

  it("passes exact untruncated search and profile scopes", () => {
    const mode = validationMode([
      {
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        readScope: {
          mode: "search",
          query: "createParser",
        },
      },
      {
        kind: "file.read_scope_satisfied",
        subject: "/tmp/readme.md",
        readScope: { mode: "profile" },
      },
    ]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "search_matches", 1, {
        mode: "search",
        query: "createParser",
        matchCount: 2,
        truncated: false,
      })]),
      evidenceCall(2, [readEvidence("/tmp/readme.md", "profile", 2, {
        mode: "profile",
        truncated: false,
      })]),
    ]);

    expect(mode.validation?.status).toBe("passed");
  });

  it("allows a complete read to satisfy a bounded scope", () => {
    const mode = validationMode([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      readScope: {
        mode: "slice",
        startLine: 100,
        endLine: 120,
      },
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "complete", 1, {
        mode: "full",
        truncated: false,
        lineCount: 200,
        lineCountKnown: true,
      })]),
    ]);

    expect(mode.validation?.status).toBe("passed");
  });

  it("requires a new read when a later mutation invalidates complete-read proof", () => {
    const mode = validationMode([{
      kind: "file.read_complete",
      subject: "/tmp/requirements.md",
      expectedKind: "file",
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/requirements.md", "complete", 1)]),
      evidenceCall(2, [{
        kind: "path_state",
        path: "/tmp/requirements.md",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "write",
        tool: "write_files",
        step: 2,
        callId: "call-2",
      }]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "failed",
      checks: [{
        message: "A later verified mutation invalidated the earlier completion proof.",
      }],
    });
  });

  it("invalidates bounded read proof after a later mutation", () => {
    const mode = validationMode([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      readScope: {
        mode: "slice",
        startLine: 10,
        endLine: 20,
      },
    }]);

    applyEvidence(mode, [
      evidenceCall(1, [readEvidence("/tmp/source.ts", "partial", 1, {
        mode: "slice",
        truncated: false,
        startLine: 10,
        endLine: 20,
      })]),
      evidenceCall(2, [{
        kind: "path_state",
        path: "/tmp/source.ts",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "patch",
        tool: "patch_files",
        step: 2,
        callId: "call-2",
      }]),
    ]);

    expect(mode.validation).toMatchObject({
      status: "failed",
      checks: [{
        message: "A later verified mutation invalidated the earlier completion proof.",
      }],
    });
  });

  it.each([
    ["calculation.evaluated", "calculation_evaluated", "14 * 3", "calculator"],
    ["database.mutation_succeeded", "database_mutated", "customers", "db_update_rows"],
    ["pulse.action_completed", "pulse_action_completed", "create", "pulse"],
    ["process.exit_success", "process_exit_success", "pnpm test", "process_run"],
    ["memory.change_succeeded", "memory_change_completed", "identity/name", "memory_remember"],
  ] as const)(
    "passes registered semantic outcome %s",
    (kind, factKind, subject, tool) => {
      const mode = validationMode([{ kind, subject }]);
      const call = verifiedFactCall(2, tool, factKind, subject);

      applyEvidence(mode, [call]);

      expect(mode.validation).toMatchObject({
        status: "passed",
        checks: [{
          kind,
          subject,
          tool,
          satisfiedBy: {
            step: 2,
            callId: "call-2",
            ref: `run:${RUN_ID}:step:2:call:call-2`,
          },
        }],
      });
    },
  );

  it("passes one exact runtime-verified call receipt by callId", () => {
    const mode = validationMode([{
      kind: "tool.call_succeeded",
      subject: "call-3",
    }]);
    const call = evidenceCall(3, []);
    call.tool = "document_query";
    call.verification = {
      version: 1,
      status: "passed",
      method: "runtime_check",
      contract: "deterministic_success_gate_v1",
      summary: "Document query passed deterministic verification.",
      checks: [],
      facts: [{
        kind: "tool.execution.verified",
        message: "document_query succeeded",
      }],
    };

    applyEvidence(mode, [call]);

    expect(mode.validation).toMatchObject({
      status: "passed",
      checks: [{
        message: "Confirmed the exact current-run tool call passed deterministic verification.",
        satisfiedBy: {
          step: 3,
          callId: "call-3",
          tool: "document_query",
        },
      }],
    });
  });

  it("passes only the exact deterministic denial and cannot reuse it as success proof", () => {
    const deniedCall: RunToolCallContext = {
      step: 4,
      callId: "call-denied",
      tool: "write_files",
      input: {
        files: [{
          path: "/external/report.txt",
          content: "must not be written",
        }],
      },
      status: "failed",
      output: "",
      error: "Mutation path is outside the configured workspace.",
      code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
      errorCategory: "permission",
      errorTarget: "/external/report.txt",
      operationStatus: "failed",
      verificationPassed: false,
    };
    const denial = validationMode([{
      kind: "tool.call_denied",
      subject: "call-denied",
      denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
    }]);
    applyEvidence(denial, [deniedCall]);

    expect(denial.validation).toMatchObject({
      status: "passed",
      checks: [{
        kind: "tool.call_denied",
        subject: "call-denied",
        denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
        status: "passed",
        message: "Confirmed the exact current-run tool call was deterministically denied without retrying it.",
        satisfiedBy: {
          step: 4,
          callId: "call-denied",
          tool: "write_files",
        },
      }],
    });

    const wrongCode = validationMode([{
      kind: "tool.call_denied",
      subject: "call-denied",
      denialCode: "WORKSTREAM_RESOURCE_MUTATION_DENIED",
    }]);
    applyEvidence(wrongCode, [deniedCall]);
    expect(wrongCode.validation?.status).toBe("failed");

    const mutationSuccess = validationMode([{
      kind: "file.written",
      subject: "/external/report.txt",
      expectedKind: "file",
    }]);
    applyEvidence(mutationSuccess, [deniedCall]);
    expect(mutationSuccess.validation?.status).toBe("failed");

    const callSuccess = validationMode([{
      kind: "tool.call_succeeded",
      subject: "call-denied",
    }]);
    applyEvidence(callSuccess, [deniedCall]);
    expect(callSuccess.validation?.status).toBe("failed");
  });

  it("rejects routing-only and historical outcomes", () => {
    const routingMode = validationMode([{
      kind: "path.exists",
      subject: "/tmp/site/index.html",
      expectedKind: "file",
    }]);
    const routing = evidenceCall(1, [
      pathEvidence("/tmp/site/index.html", true, "file", 1),
    ]);
    routing.tool = "git_context_find_workstreams";
    routing.completionEvidence![0]!.tool = routing.tool;
    applyEvidence(routingMode, [routing]);
    expect(routingMode.validation?.status).toBe("failed");

    const historicalMode = validationMode([{
      kind: "path.exists",
      subject: "/tmp/site/index.html",
      expectedKind: "file",
    }]);
    const historical = evidenceCall(1, [
      pathEvidence("/tmp/site/index.html", true, "file", 1),
    ]);
    historical.stepRef = {
      runId: "RUN-HISTORICAL",
      step: 1,
      callId: "call-1",
    };
    applyEvidence(historicalMode, [historical]);
    expect(historicalMode.validation?.status).toBe("failed");
  });
});

function applyEvidence(
  mode: VirtualModeState,
  calls: RunToolCallContext[],
): void {
  applyValidationModeEvidence(mode, buildCurrentRunVerificationIndex({
    runId: RUN_ID,
    calls,
  }));
}

function validationMode(
  checks: ModeTransitionValidationCheck[],
): VirtualModeState {
  return {
    active: "validation",
    revision: 2,
    operational: true,
    purpose: "Verify important task outcomes.",
    capabilities: ["task:validation"],
    targets: checks.map((check) => check.subject),
    validation: {
      returnMode: "observe.investigate",
      status: "pending",
      checks: checks.map((check) => ({ ...check, status: "pending" })),
    },
  };
}

function evidenceCall(
  step: number,
  completionEvidence: FilesystemCompletionEvidence[],
  verificationPassed = true,
): RunToolCallContext {
  return {
    step,
    callId: `call-${step}`,
    tool: completionEvidence[0]?.tool ?? "inspect_paths",
    input: {},
    status: "success",
    output: "verified",
    verificationPassed,
    completionEvidence,
  };
}

function verifiedFactCall(
  step: number,
  tool: string,
  factKind: string,
  subject: string,
): RunToolCallContext {
  return {
    step,
    callId: `call-${step}`,
    tool,
    input: {},
    status: "success",
    output: "verified",
    stepRef: {
      runId: RUN_ID,
      step,
      callId: `call-${step}`,
    },
    verification: {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: `${tool} contract passed.`,
      checks: [],
      facts: [{
        kind: factKind,
        message: `${factKind} verified.`,
        subject,
      }],
    },
  };
}

function pathEvidence(
  path: string,
  exists: boolean,
  actualKind: "file" | "directory",
  step: number,
): FilesystemCompletionEvidence {
  return {
    kind: "path_state",
    path,
    exists,
    actualKind,
    change: "observed",
    operation: "inspect",
    tool: "inspect_paths",
    step,
    callId: `call-${step}`,
  };
}

function readEvidence(
  path: string,
  coverage: Extract<
    FilesystemCompletionEvidence,
    { kind: "file_read" }
  >["coverage"],
  step: number,
  details: Partial<Extract<
    FilesystemCompletionEvidence,
    { kind: "file_read" }
  >> = {},
): FilesystemCompletionEvidence {
  return {
    kind: "file_read",
    path,
    requestedPath: path,
    coverage,
    contentAvailable: true,
    change: "observed",
    tool: "read_files",
    step,
    callId: `call-${step}`,
    sizeBytes: 12,
    lineCount: 1,
    sha256: "abc123",
    ...details,
  };
}
