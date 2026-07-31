export function validationOutcomeRefArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 12,
    uniqueItems: true,
    description: "The few exact current-run outcomeRef values that already prove completion of the current responsibility.",
    items: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description: "One exact outcomeRef copied from context.run.verifiedOutcomes.",
    },
  };
}

export function resourceMetadataArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: 32,
    description: "Optional semantic metadata for important durable filesystem resources selected through outcomeRefs. The runtime owns identity, kind, path, version, and lifecycle.",
    items: objectSchema({
      path: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Exact canonical absolute resource path resolved from a selected outcomeRef.",
      },
      displayName: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Short human-readable resource name.",
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Stable semantic purpose of this resource, not a restatement of its path or latest operation.",
      },
      aliases: {
        type: "array",
        maxItems: 16,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: "Useful human search names; do not repeat the absolute path.",
      },
    }, ["path", "displayName", "description", "aliases"]),
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
