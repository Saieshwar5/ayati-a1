import { describe, expect, it } from "vitest";
import {
  normalizeWorkstreamBindingProposal,
  workstreamActivateProposalSchema,
} from "../../src/ivec/workstream-binding/proposal.js";

describe("workstream binding proposal", () => {
  it("normalizes and advertises an explicit request switch", () => {
    const proposal = {
      kind: "activate",
      workstreamId: "W-20260722-0001",
      expectedWorkstreamHead: "a".repeat(40),
      requestDecision: {
        kind: "switch",
        currentRequestId: "R-0001",
        title: "Add contact form",
        request: "Add a verified contact form.",
        acceptance: ["The contact form works."],
        constraints: [],
        reason: "The user explicitly prioritized the contact form.",
      },
      evidence: ["run:RUN-1:step:1:call:read-owner"],
    };

    expect(normalizeWorkstreamBindingProposal(proposal)).toEqual(proposal);
    expect(normalizeWorkstreamBindingProposal({
      ...proposal,
      requestDecision: { ...proposal.requestDecision, currentRequestId: "invalid" },
    })).toBeUndefined();

    const properties = workstreamActivateProposalSchema()["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["requestDecision"]?.["oneOf"]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          kind: { const: "switch" },
          currentRequestId: { type: "string", pattern: "^R-[0-9]{4}$" },
        }),
        required: expect.arrayContaining(["kind", "currentRequestId"]),
      }),
    ]));
  });
});
