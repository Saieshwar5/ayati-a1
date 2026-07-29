import { describe, expect, it } from "vitest";
import { normalizeModeTransitionRequest } from "../../src/ivec/agent-runner/mode-transition-request.js";

describe("mode transition request normalization", () => {
  it("preserves the dedicated workstream routing destination and subjects", () => {
    expect(normalizeModeTransitionRequest({
      to: "workstream.route",
      purpose: "Find the durable owner before mutation.",
      capabilities: ["workstream:search"],
      subjects: [" balcony herbs ", "balcony herbs"],
    })).toMatchObject({
      to: "workstream.route",
      purpose: "Find the durable owner before mutation.",
      capabilities: ["workstream:search"],
      subjects: ["balcony herbs"],
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
