import { describe, expect, it } from "vitest";
import { modeTransitionControlCallFromRequest } from "../../src/ivec/agent-runner/mode-transition-controls.js";
import { normalizeModeTransitionRequest } from "../../src/ivec/agent-runner/mode-transition-request.js";

describe("mode transition request normalization", () => {
  it("preserves the control-only workstream routing destination", () => {
    const request = normalizeModeTransitionRequest({
      to: "workstream.route",
      purpose: "Select the verified durable owner before mutation.",
    });
    expect(request).toMatchObject({
      to: "workstream.route",
      purpose: "Select the verified durable owner before mutation.",
      capabilities: [],
    });
    expect(modeTransitionControlCallFromRequest(request)).toEqual({
      name: "decision_enter_workstream_route",
      input: {
        purpose: "Select the verified durable owner before mutation.",
      },
    });
  });

  it("preserves and normalizes a typed bounded-read validation check", () => {
    expect(normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Validate the requested source lines.",
      capabilities: ["task:validation"],
      validationChecks: [{
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        expectedKind: "file",
        readScope: {
          mode: "search",
          query: "  createParser  ",
        },
      }],
    })).toMatchObject({
      to: "validation",
      validationChecks: [{
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        expectedKind: "file",
        readScope: {
          mode: "search",
          query: "createParser",
        },
      }],
    });
  });

  it("does not manufacture a read scope from malformed input", () => {
    expect(normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Validate the requested source lines.",
      capabilities: ["task:validation"],
      validationChecks: [{
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        readScope: {
          mode: "slice",
          startLine: "10",
          endLine: 20,
        },
      }],
    }).validationChecks).toEqual([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
    }]);
  });

  it("normalizes exact no-match search scope roots", () => {
    expect(normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Validate the zero-match search.",
      capabilities: ["task:validation"],
      validationChecks: [{
        kind: "file.search_no_match",
        subject: "missing-report.txt",
        searchScope: {
          roots: ["/workspace/z", "/workspace/a", "/workspace/z"],
          maxDepth: 10,
          includeHidden: false,
        },
      }],
    }).validationChecks).toEqual([{
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace/a", "/workspace/z"],
        maxDepth: 10,
        includeHidden: false,
      },
    }]);
  });
});
