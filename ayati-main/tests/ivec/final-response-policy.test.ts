import { describe, expect, it } from "vitest";
import { createInitialHarnessContext } from "../../src/ivec/harness-context.js";
import type { LoopState, StepSummary } from "../../src/ivec/types.js";
import {
  buildFailureReply,
  buildVerifiedCompletionReply,
  canFinalizeFromWorkState,
  canMarkTerminalReplyDone,
  deriveUserInputNeededFromTerminalReply,
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
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
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
      reason: expect.stringContaining("latest file mutation failed"),
      failedStep: { step: 1 },
    });
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

  it("detects when terminal replies can mark work done", () => {
    expect(canMarkTerminalReplyDone(state())).toBe(true);
    expect(canMarkTerminalReplyDone(state({
      workState: {
        status: "not_done",
        summary: "",
        openWork: ["verify output"],
        blockers: [],
        verifiedFacts: [],
        evidence: [],
      },
    }))).toBe(false);
    expect(canMarkTerminalReplyDone(state({
      completedSteps: [step("write_files", "failed", 1)],
    }))).toBe(false);
  });

  it("extracts direct user-input requests from final replies", () => {
    expect(deriveUserInputNeededFromTerminalReply("I need one detail. Please send the target filename")).toBe("Please send the target filename.");
    expect(deriveUserInputNeededFromTerminalReply("Done.")).toBeUndefined();
  });

  it("rejects control-tool payloads as final user-facing messages", () => {
    expect(isUsableFinalResponseMessage("decision_transition_mode")).toBe(false);
    expect(isUsableFinalResponseMessage("decision_validate")).toBe(false);
    expect(isUsableFinalResponseMessage("workstream_completion")).toBe(false);
    expect(isUsableFinalResponseMessage(JSON.stringify({ kind: "act" }))).toBe(false);
    expect(isUsableFinalResponseMessage(JSON.stringify({ kind: "validate" }))).toBe(false);
    expect(isUsableFinalResponseMessage("Done. I updated the file.")).toBe(true);
  });

  it("builds verified completion replies from generated artifacts or clean summaries", () => {
    expect(buildVerifiedCompletionReply(state(), {
      ...step("write_files", "success", 1),
      artifacts: ["/tmp/workspace/index.html"],
    })).toBe("Done. I created or updated `/tmp/workspace/index.html`.");

    expect(buildVerifiedCompletionReply(state({
      workState: {
        status: "done",
        summary: "The checklist is ready.",
        verifiedFacts: [],
        evidence: [],
      },
    }))).toBe("The checklist is ready.");
  });

  it("keeps the exact accepted completion summary outside compact WorkState", () => {
    const completeSummary = "Verified implementation detail. ".repeat(80)
      + "END-OF-COMPLETION";
    expect(completeSummary.length).toBeGreaterThan(900);

    expect(buildVerifiedCompletionReply(state({
      verifiedCompletionSummary: completeSummary,
      workState: {
        status: "done",
        summary: completeSummary.slice(0, 897) + "...",
        verifiedFacts: [],
        evidence: [],
      },
    }))).toBe(completeSummary);
  });

  it("falls back to latest failure details for failure replies", () => {
    expect(buildFailureReply(state())).toBe("I couldn't complete the workstream.");
    expect(buildFailureReply(state({
      failureHistory: [{
        step: 3,
        failureType: "validation_error",
        reason: "Missing path",
        blockedTargets: ["write_files"],
      }],
    }))).toBe("I couldn't complete the workstream. Latest failure: Missing path");
  });

  it("detects work-state finalization statuses", () => {
    expect(canFinalizeFromWorkState(state({
      workState: {
        status: "done",
        summary: "Done.",
        verifiedFacts: [],
        evidence: [],
      },
    }))).toBe(true);
    expect(canFinalizeFromWorkState(state())).toBe(false);
  });
});
