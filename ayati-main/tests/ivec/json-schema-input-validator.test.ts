import { describe, expect, it } from "vitest";
import { validateJsonSchemaInput } from "../../src/ivec/agent-runner/json-schema-input-validator.js";

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
});
