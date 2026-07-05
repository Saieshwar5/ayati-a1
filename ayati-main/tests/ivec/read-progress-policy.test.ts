import { describe, expect, it } from "vitest";
import type { AgentAction } from "../../src/ivec/agent-runner/decision.js";
import {
  createEmptyReadProgressState,
  evaluateReadProgressGuard,
  markReadProgressRejected,
  updateReadProgressAfterActOutput,
} from "../../src/ivec/agent-runner/read-progress-policy.js";
import type { ActOutput } from "../../src/ivec/types.js";

describe("read progress policy", () => {
  it("allows the first batched read and records its signature", () => {
    const action = actionFor("read_files", {
      files: [
        { path: "site/index.html" },
        { path: "site/styles.css" },
      ],
    });

    expect(evaluateReadProgressGuard(undefined, action)).toBeUndefined();

    const state = updateReadProgressAfterActOutput(undefined, outputFor("read_files", action.calls[0]?.input));

    expect(state.readOnlyStepCount).toBe(1);
    expect(state.signatures).toHaveLength(1);
  });

  it("blocks duplicate reads before any mutation", () => {
    const input = { path: "site/index.html" };
    const first = updateReadProgressAfterActOutput(undefined, outputFor("read_file", input));

    const violation = evaluateReadProgressGuard(first, actionFor("read_file", input));

    expect(violation).toMatchObject({
      code: "R_DUPLICATE_READ",
      blockedTargets: ["read_file"],
    });
  });

  it("blocks additional read-only steps after enough context has been gathered", () => {
    let state = createEmptyReadProgressState();
    state = updateReadProgressAfterActOutput(state, outputFor("read_file", { path: "site/index.html" }));
    state = updateReadProgressAfterActOutput(state, outputFor("read_file", { path: "site/styles.css" }));
    state = updateReadProgressAfterActOutput(state, outputFor("search_in_files", { query: "newsletter", roots: ["site"] }));

    const violation = evaluateReadProgressGuard(state, actionFor("list_directory", { path: "site" }));

    expect(violation).toMatchObject({
      code: "R_MUTATION_EXPECTED_AFTER_CONTEXT",
      blockedTargets: ["list_directory"],
    });
  });

  it("resets read pressure after a successful mutation", () => {
    let state = updateReadProgressAfterActOutput(undefined, outputFor("read_file", { path: "site/index.html" }));
    state = updateReadProgressAfterActOutput(state, outputFor("write_file", { path: "site/index.html", content: "updated" }));

    expect(state.mutationStepCount).toBe(1);
    expect(state.readOnlyStepCount).toBe(0);
    expect(state.signatures).toEqual([]);
    expect(evaluateReadProgressGuard(state, actionFor("read_file", { path: "site/index.html" }))).toBeUndefined();
  });

  it("tracks rejected read attempts separately from executed reads", () => {
    const state = markReadProgressRejected(createEmptyReadProgressState());

    expect(state.rejectedReadCount).toBe(1);
    expect(state.readOnlyStepCount).toBe(0);
  });
});

function actionFor(tool: string, input: Record<string, unknown>): AgentAction {
  return {
    mode: "single",
    calls: [{
      id: "call-1",
      tool,
      input,
      dependsOn: [],
    }],
    allowedTools: [tool],
    assertions: [],
  };
}

function outputFor(tool: string, input: unknown): ActOutput {
  return {
    finalText: "",
    toolCalls: [{
      tool,
      input,
      output: "ok",
      operationStatus: "succeeded",
    }],
  };
}
