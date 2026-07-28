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
        kind: "defer_current_and_create",
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
    expect(properties["requestDecision"]?.["description"]).toEqual(
      expect.stringContaining("separate outcome"),
    );
    const decisions = properties["requestDecision"]?.["oneOf"] as Array<{
      description: string;
      properties: Record<string, unknown>;
      required: string[];
    }>;
    expect(decisions).toHaveLength(8);
    expect(decisions.find((decision) =>
      (decision.properties["kind"] as { const?: string }).const === "continue_current"))
      .toMatchObject({
        description: expect.stringContaining("observed request status"),
        properties: {
          requestId: expect.objectContaining({
            description: expect.stringContaining("exact request ID"),
          }),
        },
      });
    expect(decisions.find((decision) =>
      (decision.properties["kind"] as { const?: string }).const === "create_and_activate"))
      .toMatchObject({ description: expect.stringContaining("no request is active") });
    expect(decisions.find((decision) =>
      (decision.properties["kind"] as { const?: string }).const === "defer_current_and_create"))
      .toMatchObject({
        description: expect.stringContaining("separate active outcome"),
        properties: {
          currentRequestId: expect.objectContaining({
            type: "string",
            pattern: "^R-[0-9]{4}$",
            description: expect.stringContaining("exact active request ID"),
          }),
        },
        required: expect.arrayContaining(["kind", "currentRequestId"]),
      });
  });
});
