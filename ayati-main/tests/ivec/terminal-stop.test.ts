import { describe, expect, it } from "vitest";
import type { LoopState } from "../../src/ivec/types.js";
import { dispatchTerminalStop } from "../../src/ivec/agent-runner/terminal-stop.js";

function state(input: Partial<LoopState> = {}): LoopState {
  return {
    runId: "RUN-1",
    currentSeq: 1,
    userMessage: "Please handle it.",
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
    maxIterations: 30,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: {
      active: "observe.locate",
      revision: 1,
      operational: true,
      capabilities: ["file:search"],
      targets: [],
      mutationScopes: [],
    },
    hotContext: { loaded: [], available: [] },
    harnessContext: {} as LoopState["harnessContext"],
    ...input,
  };
}

const stop = {
  outcome: "needs_user_input" as const,
  response: "Which result should I use?",
};

describe("terminal stop uncertainty", () => {
  it("accepts the typed needs-user-input decision without re-parsing prose", () => {
    const result = dispatchTerminalStop(state({
      toolContext: {
        recent: [],
        toolCalls: [{
          step: 1,
          tool: "find_files",
          input: { query: "story.txt" },
          status: "success",
          output: "(no matches)",
        }],
      },
    }), stop);

    expect(result).toMatchObject({
      accepted: true,
      outcome: "needs_user_input",
      nextWorkState: { status: "needs_user_input" },
    });
  });

  it("accepts the same typed control when structured discovery evidence is present", () => {
    const result = dispatchTerminalStop(state({
      toolContext: {
        recent: [],
        toolCalls: [{
          step: 1,
          tool: "find_files",
          input: { query: "story.txt" },
          status: "success",
          output: "two paths",
          projectionMetadata: {
            matchCount: 2,
            matches: [
              { absolutePath: "/workspace/a/story.txt" },
              { absolutePath: "/workspace/b/story.txt" },
            ],
          },
        }],
      },
    }), stop);

    expect(result).toMatchObject({
      accepted: true,
      outcome: "needs_user_input",
      nextWorkState: { status: "needs_user_input" },
    });
  });
});
