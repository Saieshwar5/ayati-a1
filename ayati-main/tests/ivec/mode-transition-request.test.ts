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

  it("preserves exact validation outcome references and resource metadata", () => {
    expect(normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Validate the requested source lines.",
      capabilities: ["task:validation"],
      outcomeRefs: ["  run:RUN-1:step:1:call:read-1:outcome:1  "],
      criterionProofs: [{
        criterionIndex: 0,
        outcomeRefs: ["  run:RUN-1:step:1:call:read-1:outcome:1  "],
      }],
      resourceMetadata: [{
        path: "/tmp/source.ts",
        displayName: "  Source file  ",
        description: "  Parser implementation  ",
        aliases: [" parser ", "parser"],
      }],
    })).toMatchObject({
      to: "validation",
      outcomeRefs: ["run:RUN-1:step:1:call:read-1:outcome:1"],
      criterionProofs: [{
        criterionIndex: 0,
        outcomeRefs: ["run:RUN-1:step:1:call:read-1:outcome:1"],
      }],
      resourceMetadata: [{
        path: "/tmp/source.ts",
        displayName: "Source file",
        description: "Parser implementation",
        aliases: ["parser"],
      }],
    });
  });

  it("does not accept model-supplied validation checks", () => {
    const request = normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Try to manufacture completion proof.",
      capabilities: ["task:validation"],
      validationChecks: [{
        kind: "file.read_complete",
        subject: "/tmp/source.ts",
      }],
    });

    expect(request.validationChecks).toBeUndefined();
    expect(request.outcomeRefs).toBeUndefined();
  });

  it("preserves duplicate and empty references for deterministic rejection", () => {
    const request = normalizeModeTransitionRequest({
      to: "validation",
      purpose: "Validate exact current-run outcomes.",
      capabilities: ["task:validation"],
      outcomeRefs: [" outcome-1 ", "outcome-1", "   "],
    });

    expect(request.outcomeRefs).toEqual(["outcome-1", "outcome-1", ""]);
  });
});
