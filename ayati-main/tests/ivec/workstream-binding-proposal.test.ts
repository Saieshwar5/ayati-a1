import { describe, expect, it } from "vitest";
import {
  normalizeWorkstreamBindingProposal,
  workstreamActivateProposalSchema,
  workstreamCreateProposalSchema,
} from "../../src/ivec/workstream-binding/proposal.js";

describe("workstream binding proposal", () => {
  it("keeps runtime-owned creation fields out of the model contract", () => {
    const proposal = {
      kind: "create" as const,
      title: "Balcony herb notes",
      objective: "Create and maintain the balcony herb notes.",
      initialRequest: {
        title: "Create herb notes",
        request: "Create balcony-herbs.md.",
        acceptance: ["balcony-herbs.md exists and contains the requested notes."],
        constraints: [],
      },
    };

    expect(normalizeWorkstreamBindingProposal(proposal)).toEqual(proposal);
    const schema = workstreamCreateProposalSchema();
    expect(schema["required"]).toEqual(["title", "objective", "initialRequest"]);
    expect(schema["properties"]).toEqual(expect.not.objectContaining({
      kind: expect.anything(),
      resources: expect.anything(),
      evidence: expect.anything(),
    }));
  });

  it("normalizes and advertises an explicit request switch", () => {
    const proposal = {
      kind: "activate",
      workstreamId: "W-20260722-0001",
      requestDecision: {
        kind: "defer_current_and_create",
        currentRequestId: "R-0001",
        title: "Add contact form",
        request: "Add a verified contact form.",
        acceptance: ["The contact form works."],
        constraints: [],
        reason: "The user explicitly prioritized the contact form.",
      },
      resourceIds: ["RES-0123456789ABCDEF01234567"],
    };

    expect(normalizeWorkstreamBindingProposal(proposal)).toEqual(proposal);
    expect(normalizeWorkstreamBindingProposal({
      ...proposal,
      requestDecision: { ...proposal.requestDecision, currentRequestId: "invalid" },
    })).toBeUndefined();
    expect(normalizeWorkstreamBindingProposal({
      ...proposal,
      resourceIds: ["invalid"],
    })).toBeUndefined();

    const schema = workstreamActivateProposalSchema();
    expect(schema["required"]).toEqual([
      "workstreamId",
      "requestDecision",
      "resourceIds",
    ]);
    const properties = schema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties).not.toHaveProperty("kind");
    expect(properties).not.toHaveProperty("expectedWorkstreamHead");
    expect(properties).not.toHaveProperty("evidence");
    expect(properties["resourceIds"]).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8,
    });
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
