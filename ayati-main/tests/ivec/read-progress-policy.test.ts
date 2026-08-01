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

    expect(state.observationalStepCount).toBe(1);
    expect(state.signatures).toHaveLength(1);
  });

  it("blocks duplicate reads before any mutation", () => {
    const input = { files: [{ path: "site/index.html" }] };
    const first = updateReadProgressAfterActOutput(undefined, outputFor("read_files", input));

    const violation = evaluateReadProgressGuard(first, actionFor("read_files", input));

    expect(violation).toMatchObject({
      code: "R_DUPLICATE_READ",
      blockedTargets: ["read_files"],
    });
  });

  it("treats omitted and explicit path-only search modes as the same observation", () => {
    const first = updateReadProgressAfterActOutput(undefined, outputFor(
      "search_in_files",
      { query: "Amber Marsh", roots: ["/workspace"] },
    ));

    expect(evaluateReadProgressGuard(first, actionFor("search_in_files", {
      query: "Amber Marsh",
      roots: ["/workspace"],
      resultMode: "paths",
      contextLines: 4,
    }))).toMatchObject({
      code: "R_DUPLICATE_READ",
      blockedTargets: ["search_in_files"],
    });
  });

  it("allows an explicit snippet search after a path-only locate result", () => {
    const first = updateReadProgressAfterActOutput(undefined, outputFor(
      "search_in_files",
      { query: "Amber Marsh", roots: ["/workspace"] },
    ));

    expect(evaluateReadProgressGuard(first, actionFor("search_in_files", {
      query: "Amber Marsh",
      roots: ["/workspace"],
      resultMode: "snippets",
      contextLines: 1,
    }))).toBeUndefined();
  });

  it("allows a complete count after a path-only locate result", () => {
    const first = updateReadProgressAfterActOutput(undefined, outputFor(
      "search_in_files",
      { query: "Amber Marsh", roots: ["/workspace"] },
    ));

    expect(evaluateReadProgressGuard(first, actionFor("search_in_files", {
      query: "Amber Marsh",
      roots: ["/workspace"],
      resultMode: "count",
    }))).toBeUndefined();
  });

  it("treats equivalent complete counts as duplicates despite irrelevant output options", () => {
    const first = updateReadProgressAfterActOutput(undefined, outputFor(
      "search_in_files",
      {
        query: "swimming pool access code",
        roots: ["/workspace/reference", "/workspace/archive"],
        resultMode: "count",
        maxResults: 1,
      },
    ));

    expect(evaluateReadProgressGuard(first, actionFor("search_in_files", {
      query: "swimming pool access code",
      roots: ["/workspace/archive", "/workspace/reference"],
      resultMode: "count",
      maxDepth: 10,
      includeHidden: false,
      caseSensitive: false,
      maxResults: 500,
    }))).toMatchObject({
      code: "R_DUPLICATE_READ",
      blockedTargets: ["search_in_files"],
      allowedNextActions: [
        expect.stringContaining("outcomeRef"),
        expect.any(String),
        expect.any(String),
      ],
    });
  });

  it("allows a broader hidden-file search after a visible-only search", () => {
    const first = updateReadProgressAfterActOutput(undefined, outputFor(
      "search_in_files",
      { query: "needle", roots: ["/workspace"], resultMode: "count" },
    ));

    expect(evaluateReadProgressGuard(first, actionFor("search_in_files", {
      query: "needle",
      roots: ["/workspace"],
      resultMode: "count",
      includeHidden: true,
    }))).toBeUndefined();
  });

  it("allows more than three distinct observations when additional coverage is needed", () => {
    let state = createEmptyReadProgressState();
    state = updateReadProgressAfterActOutput(state, outputFor("read_files", { files: [{ path: "site/index.html" }] }));
    state = updateReadProgressAfterActOutput(state, outputFor("read_files", { files: [{ path: "site/styles.css" }] }));
    state = updateReadProgressAfterActOutput(state, outputFor("search_in_files", { query: "newsletter", roots: ["site"] }));

    expect(evaluateReadProgressGuard(
      state,
      actionFor("list_directory", { path: "site" }),
    )).toBeUndefined();
  });

  it("resets read pressure after a successful mutation", () => {
    let state = updateReadProgressAfterActOutput(undefined, outputFor("read_files", { files: [{ path: "site/index.html" }] }));
    state = updateReadProgressAfterActOutput(state, outputFor("write_files", {
      files: [{ path: "site/index.html", content: "updated" }],
    }));

    expect(state.mutationStepCount).toBe(1);
    expect(state.observationalStepCount).toBe(0);
    expect(state.signatures).toEqual([]);
    expect(evaluateReadProgressGuard(state, actionFor("read_files", { files: [{ path: "site/index.html" }] }))).toBeUndefined();
  });

  it("tracks rejected read attempts separately from executed reads", () => {
    const state = markReadProgressRejected(createEmptyReadProgressState());

    expect(state.rejectedReadCount).toBe(1);
    expect(state.observationalStepCount).toBe(0);
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
