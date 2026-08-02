import { describe, expect, it } from "vitest";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import {
  buildFailureReply,
  canMarkTerminalReplyDone,
  isUsableFinalResponseMessage,
  shouldRejectTerminalReplyForUnresolvedMutation,
} from "../../src/ivec/agent-runner/final-response-policy.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

function state(input: Partial<LoopState> = {}): LoopState {
  const contextEngine = contextEngineFixture({ runId: "R-1", message: "update the html file" });
  return {
    runId: "R-1",
    currentSeq: 1,
    userMessage: "update the html file",
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 1,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    harnessContext: createInitialHarnessContext({
      contextEngine: {
        ...contextEngine,
        current: {
          ...contextEngine.current,
          routing: {
            status: "bound",
            workstreamId: "W-1",
            requestId: "REQ-1",
            branch: "main",
          },
        },
        focus: {
          status: "active",
          ref: "refs/heads/main",
          workstreamId: "W-1",
        },
      },
    }),
    ...input,
  };
}

function step(tool: string, outcome: "success" | "failed", stepNumber: number): StepSummary {
  return {
    step: stepNumber,
    outcome,
    summary: `${tool} ${outcome}`,
    newFacts: [],
    artifacts: [],
    toolsUsed: [tool],
    toolSuccessCount: outcome === "success" ? 1 : 0,
    toolFailureCount: outcome === "failed" ? 1 : 0,
  };
}

describe("final response policy", () => {
  it("rejects a completed reply after a failed file mutation with no later success", () => {
    const rejection = shouldRejectTerminalReplyForUnresolvedMutation(state({
      completedSteps: [step("write_files", "failed", 1)],
    }), {
      kind: "reply",
      status: "completed",
      message: "Done.",
    });

    expect(rejection).toMatchObject({
      reason: expect.stringContaining("latest file mutation"),
      failedStep: { step: 1 },
    });
  });

  it("uses verified mutation history instead of guessing intent from user wording", () => {
    const rejection = shouldRejectTerminalReplyForUnresolvedMutation(state({
      userMessage: "Produce the requested result.",
      completedSteps: [step("write_files", "failed", 1)],
    }), {
      kind: "reply",
      status: "completed",
      message: "Done.",
    });

    expect(rejection).toMatchObject({ failedStep: { step: 1 } });
    expect(shouldRejectTerminalReplyForUnresolvedMutation(state({
      userMessage: "Explain how website updates work.",
      completedSteps: [],
    }), {
      kind: "reply",
      status: "completed",
      message: "Here is how they work.",
    })).toBeNull();
  });

  it("allows a completed reply after a later successful file mutation", () => {
    const rejection = shouldRejectTerminalReplyForUnresolvedMutation(state({
      completedSteps: [
        step("write_files", "failed", 1),
        step("write_files", "success", 2),
      ],
    }), {
      kind: "reply",
      status: "completed",
      message: "Done.",
    });

    expect(rejection).toBeNull();
  });

  it("allows a truthful completed reply when exact permission denial validation accounts for the failed mutation", () => {
    const deniedStep: StepSummary = {
      ...step("write_files", "failed", 1),
      failureType: "permission",
      failedCallIds: ["call-denied"],
    };
    const current = state({
      completedSteps: [deniedStep],
      virtualMode: {
        active: "validation",
        revision: 2,
        operational: true,
        purpose: "Validate the exact denied mutation.",
        capabilities: ["task:validation"],
        targets: ["call-denied"],
        validation: {
          returnMode: "execute",
          status: "passed",
          checks: [{
            kind: "tool.call_denied",
            subject: "call-denied",
            denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE",
            status: "passed",
            tool: "write_files",
            message: "Confirmed exact denial.",
            satisfiedBy: {
              step: 1,
              callId: "call-denied",
              tool: "write_files",
              ref: "run:R-1:step:1:call:call-denied",
            },
          }],
        },
      },
    });

    expect(shouldRejectTerminalReplyForUnresolvedMutation(current, {
      kind: "reply",
      status: "completed",
      message: "I could not write the external file because mutations are workspace-only.",
    })).toBeNull();

    current.virtualMode.validation!.checks[0]!.satisfiedBy!.callId = "call-other";
    expect(shouldRejectTerminalReplyForUnresolvedMutation(current, {
      kind: "reply",
      status: "completed",
      message: "I could not write the external file because mutations are workspace-only.",
    })).toMatchObject({
      failedStep: { step: 1 },
    });
  });

  it("detects when terminal replies can mark work done", () => {
    expect(canMarkTerminalReplyDone(state())).toBe(true);
    expect(canMarkTerminalReplyDone(state({
      workState: {
        status: "in_progress",
        summary: "Implementation is waiting for validation.",
        plan: [{
          id: "verify",
          task: "Verify output",
          status: "active",
        }],
        importantContext: [],
      },
    }))).toBe(false);
    expect(canMarkTerminalReplyDone(state({
      completedSteps: [step("write_files", "failed", 1)],
    }))).toBe(false);
  });

  it("requires all current failures to be resolved before marking work done", () => {
    const failure = {
      step: 2,
      failureType: "tool_error" as const,
      reason: "The database query failed.",
      blockedTargets: ["db_query"],
      repairScope: "action" as const,
    };
    expect(canMarkTerminalReplyDone(state({
      failureHistory: [failure],
    }))).toBe(false);
    expect(canMarkTerminalReplyDone(state({
      failureHistory: [{
        ...failure,
        resolution: {
          iteration: 3,
          kind: "verified_action",
        },
      }],
    }))).toBe(true);
  });

  it("rejects control-tool payloads as final user-facing messages", () => {
    expect(isUsableFinalResponseMessage("decision_enter_observe_investigate")).toBe(false);
    expect(isUsableFinalResponseMessage("decision_resolve_create")).toBe(false);
    expect(isUsableFinalResponseMessage("decision_stop")).toBe(false);
    expect(isUsableFinalResponseMessage("workstream_completion")).toBe(false);
    expect(isUsableFinalResponseMessage(JSON.stringify({ kind: "act" }))).toBe(false);
    expect(isUsableFinalResponseMessage(JSON.stringify({ kind: "stop" }))).toBe(false);
    expect(isUsableFinalResponseMessage("Done. I updated the file.")).toBe(true);
  });

  it("uses safe user-facing failure categories without leaking internal repairs", () => {
    expect(buildFailureReply(state())).toBe("I couldn't complete the current workstream request.");
    expect(buildFailureReply(state({
      failureHistory: [{
        step: 3,
        failureType: "validation_error",
        reason: "VALIDATION_REJECTED: No current blocker supports a blocked outcome.",
        blockedTargets: ["write_files"],
      }],
    }))).toBe(
      "I couldn't complete the current workstream request. The request could not be completed safely.",
    );
    expect(buildFailureReply(state({
      failureHistory: [{
        step: 3,
        failureType: "validation_error",
        reason: "Recovered missing path",
        blockedTargets: ["write_files"],
        repairScope: "action",
        resolution: {
          iteration: 4,
          kind: "verified_action",
        },
      }],
    }))).toBe("I couldn't complete the current workstream request.");

    const unboundContext = contextEngineFixture({
      runId: "R-1",
      message: "Find the missing file.",
    });
    expect(buildFailureReply(state({
      harnessContext: createInitialHarnessContext({
        contextEngine: unboundContext,
      }),
      failureHistory: [{
        step: 2,
        failureType: "missing_path",
        reason: "PATH_OUTSIDE_WORKSPACE_ROOT: internal path details",
        blockedTargets: [],
      }],
    }))).toBe(
      "I couldn't complete this request. A required path was unavailable.",
    );
  });

});
