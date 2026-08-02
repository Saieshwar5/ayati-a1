import { describe, expect, it } from "vitest";
import { buildRunLimitHandoff } from "../../src/ivec/agent-runner/run-limit-handoff.js";
import type { LoopState, RunToolCallContext } from "../../src/ivec/types.js";

describe("run-limit handoff", () => {
  it("truthfully reports an unbound run with no verified task action", () => {
    const handoff = buildRunLimitHandoff(state(), 30);

    expect(handoff).toMatchObject({
      bound: false,
      verifiedEffectCount: 0,
      verifiedStepCount: 0,
      workState: {
        status: "in_progress",
        summary: "Run paused at the decision limit before any task action was durably verified.",
        nextAction: "Create the teaching website.",
      },
    });
    expect(handoff.response).toContain("30-decision limit");
    expect(handoff.response).toContain("No task action was durably verified");
    expect(handoff.response).toContain("No workstream or request was created or activated");
  });

  it("preserves exact verified effects and pauses active plan work", () => {
    const current = state(true);
    current.workState.plan = [
      { id: "html", task: "Create the homepage", status: "done" },
      { id: "script", task: "Create and validate script.js", status: "active" },
    ];
    current.toolContext = {
      recent: [],
      toolCalls: [verifiedWrite()],
    };

    const handoff = buildRunLimitHandoff(current, 30);

    expect(handoff).toMatchObject({
      bound: true,
      requestId: "R-0002",
      verifiedEffectCount: 1,
      workState: {
        status: "in_progress",
        plan: [
          { id: "html", status: "done" },
          { id: "script", status: "pending" },
        ],
        nextAction: "Create and validate script.js",
      },
    });
    expect(handoff.workState.importantContext).toContainEqual(expect.objectContaining({
      kind: "artifact",
      value: "Created /workspace/site/index.html.",
      ref: "run:RUN-LIMIT:step:1:call:write-index",
    }));
    expect(handoff.response).toContain("Request R-0002 remains active");
    expect(handoff.response).toContain("Created /workspace/site/index.html");
    expect(handoff.response).toContain("Create and validate script.js");
  });

  it("reports only task steps whose deterministic validation passed", () => {
    const current = state();
    current.completedSteps = [{
      step: 1,
      outcome: "success",
      summary: "Read the exact requirements file.",
      evidenceSummary: "Verified the complete requirements-file read.",
      newFacts: [],
      artifacts: [],
      toolSuccessCount: 1,
      toolFailureCount: 0,
      validationStatus: "passed",
    }, {
      step: 2,
      outcome: "success",
      summary: "Claimed an unverified follow-up.",
      newFacts: [],
      artifacts: [],
      toolSuccessCount: 1,
      toolFailureCount: 0,
      validationStatus: "skipped",
    }];

    const handoff = buildRunLimitHandoff(current, 30);

    expect(handoff.verifiedStepCount).toBe(1);
    expect(handoff.response).toContain("Verified the complete requirements-file read");
    expect(handoff.response).not.toContain("Claimed an unverified follow-up");
  });
});

function state(bound = false): LoopState {
  return {
    runId: "RUN-LIMIT",
    userMessage: "Create the teaching website.",
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    completedSteps: [],
    harnessContext: bound
      ? {
          contextEngine: {
            current: {
              runId: "RUN-LIMIT",
              streamId: "S-1",
              triggerSeq: 1,
              routing: {
                status: "bound",
                workstreamId: "W-20260802-0001",
                requestId: "R-0002",
              },
            },
            workstream: {
              currentRequest: {
                id: "R-0002",
                title: "Create website",
                status: "active",
                request: "Create and validate the teaching website.",
                acceptance: [],
                constraints: [],
              },
            },
          },
        }
      : {
          contextEngine: {
            current: {
              runId: "RUN-LIMIT",
              streamId: "S-1",
              triggerSeq: 1,
              routing: { status: "unbound" },
            },
          },
        },
  } as unknown as LoopState;
}

function verifiedWrite(): RunToolCallContext {
  return {
    step: 1,
    callId: "write-index",
    tool: "write_files",
    input: {},
    status: "success",
    output: "",
    verificationPassed: true,
    completionEvidence: [{
      kind: "path_state",
      path: "/workspace/site/index.html",
      exists: true,
      actualKind: "file",
      change: "mutated",
      operation: "write",
      beforeKind: "missing",
      afterKind: "file",
      afterSha256: "created-hash",
      writeStatus: "created",
      tool: "write_files",
      step: 1,
      callId: "write-index",
    }],
  };
}
