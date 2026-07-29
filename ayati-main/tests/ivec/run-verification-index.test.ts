import { describe, expect, it } from "vitest";
import {
  buildCurrentRunVerificationIndex,
  findLatestInvalidatedCompleteRead,
  findLatestVerifiedCompleteRead,
  findLatestVerifiedOutcomeForCheck,
  findLatestVerifiedPathOutcome,
} from "../../src/ivec/agent-runner/run-verification-index.js";
import type {
  FilesystemCompletionEvidence,
  RunToolCallContext,
} from "../../src/ivec/types.js";

const RUN_ID = "RUN-VERIFY-1";

describe("current-run verification index", () => {
  it("catalogs each call and normalizes passed completion and supporting outcomes", () => {
    const call = verifiedCall(1, "read_files", [
      pathEvidence("/tmp/report.txt", true, "file", 1, "read", "observed"),
      readEvidence("/tmp/report.txt", "complete", 1),
    ]);
    call.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "The complete read contract passed.",
      checks: [],
      facts: [{
        kind: "file_read",
        message: "Read the full report.",
        subject: "/tmp/report.txt",
        data: { coverage: "complete" },
      }],
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [call],
    });

    expect(index).toMatchObject({
      version: 1,
      runId: RUN_ID,
      throughStep: 1,
      summary: {
        totalCalls: 1,
        passedCalls: 1,
        failedCalls: 0,
        notAvailableCalls: 0,
        currentOutcomes: 3,
        completionOutcomes: 2,
        supportingOutcomes: 1,
        routingOutcomes: 0,
        invalidatedOutcomes: 0,
      },
      calls: [{
        status: "passed",
        method: "tool_contract",
        source: {
          ref: `run:${RUN_ID}:step:1:call:call-1`,
          tool: "read_files",
        },
      }],
    });
    expect(index.outcomes.map((outcome) => outcome.kind)).toEqual([
      "path.exists",
      "file.read_complete",
      "tool.verified_fact",
    ]);
    expect(findLatestVerifiedCompleteRead(index, "/tmp/report.txt")).toMatchObject({
      coverage: "complete",
      contentAvailable: true,
      source: { step: 1, callId: "call-1" },
    });
  });

  it("registers verified time and health observations as validation outcomes", () => {
    const time = verifiedCall(1, "system_time", [], "time-call");
    time.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "Fresh time observed.",
      checks: [],
      facts: [{
        kind: "system_time_observed",
        message: "Fresh time observed.",
        subject: "timezone:Asia/Kolkata",
      }],
    };
    const health = verifiedCall(2, "system_health", [], "health-call");
    health.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "Fresh health observed.",
      checks: [],
      facts: [{
        kind: "system_health_observed",
        message: "Fresh health observed.",
        subject: "local-machine",
      }],
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [time, health],
    });

    expect(index.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "system.time_observed",
        subject: "timezone:Asia/Kolkata",
        role: "completion",
      }),
      expect.objectContaining({
        kind: "system.health_observed",
        subject: "local-machine",
        role: "completion",
      }),
    ]));
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "system.health_observed",
      subject: "local-machine",
    })).toMatchObject({
      source: {
        step: 2,
        callId: "health-call",
        tool: "system_health",
      },
    });
  });

  it("indexes copied paths and permission changes as typed outcomes", () => {
    const copied = verifiedCall(1, "copy", [
      pathEvidence(
        "/workspace/site/logo-link",
        true,
        "symlink",
        1,
        "copy",
        "mutated",
      ),
    ], "copy-call");
    const permissions = verifiedCall(2, "set_permissions", [
      pathEvidence(
        "/workspace/site/run.sh",
        true,
        "file",
        2,
        "permissions",
        "mutated",
      ),
    ], "permissions-call");

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [copied, permissions],
    });

    expect(index.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "path.copied",
        subject: "/workspace/site/logo-link",
        actualKind: "symlink",
      }),
      expect.objectContaining({
        kind: "file.permissions_set",
        subject: "/workspace/site/run.sh",
      }),
    ]));
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "path.copied",
      subject: "/workspace/site/logo-link",
      expectedKind: "symlink",
    })).toBeDefined();
  });

  it("separates failed and unverifiable calls without creating outcomes", () => {
    const failed = verifiedCall(1, "read_files", []);
    failed.status = "failed";
    failed.error = "File not found.";
    failed.code = "FILE_NOT_FOUND";
    failed.verificationPassed = false;

    const unavailable = verifiedCall(2, "custom_tool", []);
    delete unavailable.verificationPassed;

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [failed, unavailable],
    });

    expect(index.calls).toEqual([
      expect.objectContaining({
        status: "failed",
        code: "FILE_NOT_FOUND",
        summary: "File not found.",
      }),
      expect.objectContaining({
        status: "not_available",
        summary: "custom_tool has no deterministic verification result.",
      }),
    ]);
    expect(index.outcomes).toEqual([]);
    expect(index.summary).toMatchObject({
      passedCalls: 0,
      failedCalls: 1,
      notAvailableCalls: 1,
    });
  });

  it("indexes an exact pre-execution permission denial without creating success proof", () => {
    const denied: RunToolCallContext = {
      step: 2,
      callId: "call-denied-write",
      tool: "write_files",
      input: {
        files: [{
          path: "/external/report.txt",
          content: "must not be written",
        }],
      },
      status: "failed",
      output: "",
      error: "Mutation target is outside the configured workspace.",
      code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
      errorCategory: "permission",
      errorTarget: "/external/report.txt",
      operationStatus: "failed",
      verificationPassed: false,
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [denied],
    });

    expect(index.calls).toEqual([
      expect.objectContaining({
        status: "failed",
        code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
        errorCategory: "permission",
        errorTarget: "/external/report.txt",
      }),
    ]);
    expect(index.outcomes).toEqual([
      expect.objectContaining({
        family: "tool_denial",
        kind: "tool.call_denied",
        subject: "call-denied-write",
        denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
        tool: "write_files",
        target: "/external/report.txt",
        source: expect.objectContaining({
          step: 2,
          callId: "call-denied-write",
        }),
      }),
    ]);
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "tool.call_denied",
      subject: "call-denied-write",
      denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
    })).toMatchObject({
      family: "tool_denial",
    });
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.written",
      subject: "/external/report.txt",
    })).toBeUndefined();
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "tool.call_succeeded",
      subject: "call-denied-write",
    })).toBeUndefined();
  });

  it("does not create denial proof when failed execution is uncertain or the code is not a known pre-execution gate", () => {
    const uncertain: RunToolCallContext = {
      step: 1,
      callId: "call-uncertain",
      tool: "write_files",
      input: {},
      status: "failed",
      output: "",
      error: "Permission failure after execution began.",
      code: "UNKNOWN_PERMISSION_FAILURE",
      errorCategory: "permission",
      errorTarget: "/external/report.txt",
      verificationPassed: false,
    };
    const unknownGate: RunToolCallContext = {
      ...uncertain,
      step: 2,
      callId: "call-unknown-gate",
      operationStatus: "failed",
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [uncertain, unknownGate],
    });

    expect(index.outcomes).toEqual([]);
  });

  it("keeps successful outcomes from a partially failed multi-call step", () => {
    const passed = verifiedCall(1, "inspect_paths", [
      pathEvidence("/tmp/available.txt", true, "file", 1),
    ], "call-a");
    const failed = verifiedCall(1, "read_files", [], "call-b");
    failed.status = "failed";
    failed.error = "Second file was missing.";
    failed.verificationPassed = false;

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [passed, failed],
    });

    expect(index.summary).toMatchObject({
      totalCalls: 2,
      passedCalls: 1,
      failedCalls: 1,
      completionOutcomes: 1,
    });
    expect(findLatestVerifiedPathOutcome(index, "/tmp/available.txt")).toMatchObject({
      exists: true,
      source: { callId: "call-a" },
    });
  });

  it("projects an unchanged desired-state write as verified existence, not a write claim", () => {
    const path = "/tmp/already-current.txt";
    const call = verifiedCall(1, "write_files", [
      pathEvidence(path, true, "file", 1, "write", "observed", "unchanged"),
    ]);

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [call],
    });

    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "path.exists",
      subject: path,
      expectedKind: "file",
    })).toMatchObject({
      kind: "path.exists",
      summary: `Confirmed ${path} exists.`,
      change: "observed",
    });
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.written",
      subject: path,
    })).toBeUndefined();
  });

  it("invalidates a complete read after a later exact mutation and restores it after rereading", () => {
    const read = verifiedCall(1, "read_files", [
      readEvidence("/tmp/report.txt", "complete", 1),
    ]);
    const write = verifiedCall(2, "write_files", [
      pathEvidence("/tmp/report.txt", true, "file", 2, "write", "mutated"),
    ]);

    const stale = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [read, write],
    });

    expect(findLatestVerifiedCompleteRead(stale, "/tmp/report.txt")).toBeUndefined();
    expect(findLatestInvalidatedCompleteRead(stale, "/tmp/report.txt")).toMatchObject({
      reason: "later_mutation",
      invalidatedBy: { step: 2, tool: "write_files" },
    });

    const reread = verifiedCall(3, "read_files", [
      readEvidence("/tmp/report.txt", "complete", 3),
    ]);
    const restored = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [read, write, reread],
    });

    expect(findLatestVerifiedCompleteRead(restored, "/tmp/report.txt")).toMatchObject({
      source: { step: 3 },
    });
  });

  it("invalidates child path and read proof when a parent is deleted", () => {
    const child = "/tmp/site/archive/report.txt";
    const inspect = verifiedCall(1, "read_files", [
      pathEvidence(child, true, "file", 1, "read", "observed"),
      readEvidence(child, "complete", 1),
    ]);
    const removeParent = verifiedCall(2, "delete", [
      pathEvidence("/tmp/site/archive", false, "directory", 2, "delete", "mutated"),
    ]);

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [inspect, removeParent],
    });

    expect(findLatestVerifiedPathOutcome(index, child)).toBeUndefined();
    expect(findLatestVerifiedCompleteRead(index, child)).toBeUndefined();
    expect(index.invalidated).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "ancestor_removed" }),
    ]));
  });

  it("indexes only conclusive zero-match searches and requires the exact scope", () => {
    const completeSearch = verifiedCall(1, "find_files", [
      searchEvidence("missing-report.txt", ["/workspace"], 1),
    ]);
    const incompleteSearch = verifiedCall(2, "find_files", [
      searchEvidence("other-report.txt", ["/workspace"], 2, {
        complete: false,
        depthLimitedDirectoryCount: 1,
      }),
    ]);

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [completeSearch, incompleteSearch],
    });

    expect(index.outcomes).toContainEqual(expect.objectContaining({
      family: "filesystem_search",
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
      },
    }));
    expect(index.outcomes).not.toContainEqual(expect.objectContaining({
      subject: "other-report.txt",
    }));
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
      },
    })).toMatchObject({ source: { step: 1 } });
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace/narrow"],
        maxDepth: 10,
        includeHidden: false,
      },
    })).toBeUndefined();
  });

  it("invalidates a no-match search after a later mutation inside its root", () => {
    const search = verifiedCall(1, "find_files", [
      searchEvidence("missing-report.txt", ["/workspace"], 1),
    ]);
    const write = verifiedCall(2, "write_files", [
      pathEvidence(
        "/workspace/missing-report.txt",
        true,
        "file",
        2,
        "write",
        "mutated",
      ),
    ]);

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [search, write],
    });

    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
      },
    })).toBeUndefined();
    expect(index.invalidated).toContainEqual(expect.objectContaining({
      outcome: expect.objectContaining({
        kind: "file.search_no_match",
      }),
      reason: "later_mutation",
      invalidatedBy: expect.objectContaining({ step: 2 }),
    }));
  });

  it("promotes only satisfied bounded read scopes to completion outcomes", () => {
    const slice = verifiedCall(1, "read_files", [
      readEvidence("/tmp/source.ts", "partial", 1, {
        mode: "slice",
        truncated: false,
        startLine: 40,
        endLine: 60,
      }),
    ]);
    const truncatedSearch = verifiedCall(2, "read_files", [
      readEvidence("/tmp/source.ts", "search_matches", 2, {
        mode: "search",
        truncated: true,
        query: "createParser",
        matchCount: 10,
      }),
    ]);

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [slice, truncatedSearch],
    });

    expect(index.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: "filesystem_read",
        kind: "file.read_partial",
        role: "completion",
        readScope: {
          mode: "slice",
          startLine: 40,
          endLine: 60,
        },
      }),
      expect.objectContaining({
        family: "filesystem_read",
        kind: "file.read_partial",
        role: "supporting",
        mode: "search",
        truncated: true,
      }),
    ]));
    expect(findLatestVerifiedOutcomeForCheck(index, {
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      readScope: {
        mode: "slice",
        startLine: 45,
        endLine: 55,
      },
    })).toMatchObject({
      source: { step: 1 },
    });
  });

  it("excludes historical and internally inconsistent call references", () => {
    const historical = verifiedCall(1, "inspect_paths", [
      pathEvidence("/tmp/old.txt", true, "file", 1),
    ]);
    historical.stepRef = {
      runId: "RUN-OLD",
      step: 1,
      callId: "call-1",
    };
    const inconsistent = verifiedCall(2, "inspect_paths", [
      pathEvidence("/tmp/wrong.txt", true, "file", 2),
    ]);
    inconsistent.stepRef = {
      runId: RUN_ID,
      step: 99,
      callId: "call-2",
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [historical, inconsistent],
    });

    expect(index.calls).toEqual([]);
    expect(index.outcomes).toEqual([]);
    expect(index.excluded).toEqual([
      expect.objectContaining({
        reason: "different_run",
        referencedRunId: "RUN-OLD",
      }),
      expect.objectContaining({
        reason: "invalid_step_reference",
        referencedRunId: RUN_ID,
      }),
    ]);
  });

  it("ignores transient context loads when building durable task proof", () => {
    const contextLoad = verifiedCall(1, "context_load", []);
    contextLoad.stepKind = "transient_context";
    delete contextLoad.stepRef;
    contextLoad.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "The context load contract passed.",
      checks: [],
      facts: [{
        kind: "tool.execution.verified",
        message: "context_load succeeded",
      }],
    };
    const fileRead = verifiedCall(1, "read_files", [
      readEvidence("/tmp/report.txt", "complete", 1),
    ], "read-report");

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [contextLoad, fileRead],
    });

    expect(index).toMatchObject({
      throughStep: 1,
      summary: {
        totalCalls: 1,
        passedCalls: 1,
      },
      calls: [{
        source: {
          step: 1,
          callId: "read-report",
          tool: "read_files",
        },
      }],
    });
    expect(index.outcomes).toContainEqual(expect.objectContaining({
      kind: "file.read_complete",
      subject: "/tmp/report.txt",
      source: expect.objectContaining({
        step: 1,
        callId: "read-report",
      }),
    }));
    expect(JSON.stringify(index)).not.toContain("context_load");
  });

  it("catalogs routing evidence but never exposes it as task-completion proof", () => {
    const routing = verifiedCall(1, "git_context_find_workstreams", [
      pathEvidence("/tmp/site/index.html", true, "file", 1),
    ]);
    routing.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      summary: "Routing search succeeded.",
      checks: [],
      facts: [{
        kind: "workstream.candidate",
        message: "Observed a possible owner.",
        subject: "W-1",
      }],
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [routing],
    });

    expect(index.calls[0]).toMatchObject({
      scope: "routing",
      status: "passed",
    });
    expect(index.outcomes).toEqual([
      expect.objectContaining({ role: "routing", kind: "path.exists" }),
      expect.objectContaining({ role: "routing", kind: "tool.verified_fact" }),
    ]);
    expect(findLatestVerifiedPathOutcome(index, "/tmp/site/index.html")).toBeUndefined();
  });

  it("normalizes registered semantic facts into completion outcomes", () => {
    const call = verifiedCall(3, "process_run", []);
    call.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "The foreground command exited successfully.",
      checks: [],
      facts: [{
        kind: "process_exit_success",
        message: "Foreground process completed successfully.",
        subject: "pnpm test",
      }],
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [call],
    });

    expect(index.outcomes).toEqual([
      expect.objectContaining({
        family: "task",
        kind: "process.exit_success",
        subject: "pnpm test",
        role: "completion",
      }),
      expect.objectContaining({
        family: "verified_fact",
        factKind: "process_exit_success",
        role: "supporting",
      }),
    ]);
  });

  it("indexes non-filesystem artifacts without weakening filesystem freshness", () => {
    const call = verifiedCall(4, "db_create_table", []);
    call.artifacts = [{
      kind: "table",
      id: "customers",
      metadata: { dbPath: "/tmp/app.db" },
    }];

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [call],
    });

    expect(index.outcomes).toEqual([
      expect.objectContaining({
        family: "task",
        kind: "artifact.available",
        subject: "customers",
        artifactKind: "table",
      }),
    ]);
  });

  it("creates an exact-call fallback only for runtime-verified calls", () => {
    const runtimeVerified = verifiedCall(5, "document_query", []);
    runtimeVerified.verification = {
      version: 1,
      status: "passed",
      method: "runtime_check",
      contract: "deterministic_success_gate_v1",
      summary: "Document query passed.",
      checks: [],
      facts: [{
        kind: "tool.execution.verified",
        message: "document_query succeeded",
      }],
    };
    const contractOnly = verifiedCall(6, "custom_tool", []);
    contractOnly.verification = {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "Custom contract passed without completion facts.",
      checks: [],
      facts: [],
    };

    const index = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: [runtimeVerified, contractOnly],
    });

    expect(index.outcomes).toEqual([
      expect.objectContaining({
        family: "verified_fact",
        factKind: "tool.execution.verified",
      }),
      expect.objectContaining({
        family: "task",
        kind: "tool.call_succeeded",
        subject: "call-5",
        source: expect.objectContaining({ tool: "document_query" }),
      }),
    ]);
  });

  it("rebuilds identically from a persisted JSON round trip", () => {
    const calls = [
      verifiedCall(2, "write_files", [
        pathEvidence("/tmp/site/index.html", true, "file", 2, "write", "mutated"),
      ]),
      verifiedCall(1, "inspect_paths", [
        pathEvidence("/tmp/site/index.html", false, "file", 1),
      ]),
    ];

    const first = buildCurrentRunVerificationIndex({ runId: RUN_ID, calls });
    const restoredCalls = JSON.parse(JSON.stringify(calls)) as RunToolCallContext[];
    const rebuilt = buildCurrentRunVerificationIndex({
      runId: RUN_ID,
      calls: restoredCalls,
    });

    expect(rebuilt).toEqual(first);
    expect(findLatestVerifiedPathOutcome(rebuilt, "/tmp/site/index.html")).toMatchObject({
      kind: "file.written",
      exists: true,
      source: { step: 2 },
    });
  });
});

function verifiedCall(
  step: number,
  tool: string,
  completionEvidence: FilesystemCompletionEvidence[],
  callId = `call-${step}`,
): RunToolCallContext {
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
    completionEvidence: completionEvidence.map((evidence) => ({
      ...evidence,
      callId,
    })),
  };
}

function pathEvidence(
  path: string,
  exists: boolean,
  actualKind: "file" | "directory" | "symlink",
  step: number,
  operation: Extract<FilesystemCompletionEvidence, { kind: "path_state" }>["operation"] = "inspect",
  change: "observed" | "mutated" = "observed",
  writeStatus?: "created" | "replaced" | "unchanged",
): FilesystemCompletionEvidence {
  return {
    kind: "path_state",
    path,
    exists,
    actualKind,
    change,
    operation,
    ...(writeStatus ? { writeStatus } : {}),
    tool: operation === "write"
      ? "write_files"
      : operation === "delete"
        ? "delete"
        : operation === "read"
          ? "read_files"
          : "inspect_paths",
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

function searchEvidence(
  query: string,
  roots: string[],
  step: number,
  details: Partial<Extract<
    FilesystemCompletionEvidence,
    { kind: "file_search" }
  >> = {},
): FilesystemCompletionEvidence {
  return {
    kind: "file_search",
    query,
    roots,
    matchCount: 0,
    maxDepth: 10,
    includeHidden: false,
    capped: false,
    errorCount: 0,
    depthLimitedDirectoryCount: 0,
    complete: true,
    change: "observed",
    tool: "find_files",
    step,
    callId: `call-${step}`,
    ...details,
  };
}
