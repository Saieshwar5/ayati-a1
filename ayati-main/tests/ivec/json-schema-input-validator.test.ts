import { describe, expect, it } from "vitest";
import { validateJsonSchemaInput } from "../../src/ivec/agent-runner/json-schema-input-validator.js";
import { workstreamActivateProposalSchema } from "../../src/ivec/workstream-binding/proposal.js";

describe("JSON Schema input validator", () => {
  it("keeps deterministic uniqueItems validation for canonical tool inputs", () => {
    const schema = {
      type: "object",
      properties: {
        capabilities: {
          type: "array",
          uniqueItems: true,
          items: { type: "string" },
        },
      },
      required: ["capabilities"],
      additionalProperties: false,
    };

    expect(validateJsonSchemaInput(
      { capabilities: ["workstream:search", "workstream:search"] },
      schema,
      { enforceAdditionalProperties: true },
    )).toBe("field 'capabilities' must not contain duplicate items");

    expect(validateJsonSchemaInput(
      { capabilities: ["workstream:search", "workstream:read"] },
      schema,
      { enforceAdditionalProperties: true },
    )).toBeNull();
  });

  it.each([
    {
      kind: "continue_current",
      requestId: "R-0001",
    },
    {
      kind: "activate_existing",
      requestId: "R-0002",
    },
    {
      kind: "resume_blocked",
      requestId: "R-0003",
    },
    {
      kind: "amend_current",
      currentRequestId: "R-0001",
      authority: "user",
      patch: {
        constraints: ["Keep the existing implementation dependency-free."],
      },
    },
    {
      kind: "create_and_activate",
      title: "Add testimonials",
      request: "Add a testimonial section.",
      acceptance: ["The testimonial section is visible."],
      constraints: [],
    },
    {
      kind: "create_queued",
      title: "Add testimonials later",
      request: "Add a testimonial section later.",
      acceptance: ["The testimonial section is visible."],
      constraints: [],
    },
    {
      kind: "defer_current_and_create",
      currentRequestId: "R-0001",
      title: "Add testimonials",
      request: "Add a testimonial section now.",
      acceptance: ["The testimonial section is visible."],
      constraints: [],
    },
    {
      kind: "defer_current_and_activate_existing",
      currentRequestId: "R-0001",
      nextRequestId: "R-0002",
    },
  ])("reports the error from the $kind operation selected by kind", (requestDecision) => {
    const result = validateJsonSchemaInput({
      workstreamId: "W-20260731-0001",
      requestDecision: {
        ...requestDecision,
        reason: "x".repeat(501),
      },
      resourceIds: ["RES-0123456789ABCDEF01234567"],
    }, workstreamActivateProposalSchema(), {
      enforceAdditionalProperties: true,
    });

    expect(result).toBe(
      "field 'requestDecision.reason' must contain at most 500 characters",
    );
  });

  it("reports the allowed request operations for an unknown kind", () => {
    const result = validateJsonSchemaInput({
      workstreamId: "W-20260731-0001",
      requestDecision: {
        kind: "replace_current",
      },
      resourceIds: ["RES-0123456789ABCDEF01234567"],
    }, workstreamActivateProposalSchema(), {
      enforceAdditionalProperties: true,
    });

    expect(result).toContain("field 'requestDecision.kind' must be one of");
    expect(result).toContain("\"amend_current\"");
    expect(result).toContain("\"defer_current_and_create\"");
    expect(result).not.toContain("missing required field 'requestDecision.requestId'");
  });

  it("keeps ordinary oneOf validation for unions without a kind discriminator", () => {
    const schema = {
      oneOf: [
        { type: "string", minLength: 2 },
        { type: "number", minimum: 1 },
      ],
    };

    expect(validateJsonSchemaInput("ok", schema)).toBeNull();
    expect(validateJsonSchemaInput(true, schema)).toBe(
      "field 'input' expected type 'string', got 'boolean'",
    );
  });
});
