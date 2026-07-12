function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function arraySchema(items: Record<string, unknown>, maxItems: number, minItems = 0): Record<string, unknown> {
  return {
    type: "array",
    items,
    minItems,
    maxItems,
  };
}

const SOURCE_SCHEMA = {
  oneOf: [
    objectSchema({
      kind: { type: "string", const: "conversation" },
      seq: { type: "integer", minimum: 1 },
    }),
    objectSchema({
      kind: { type: "string", const: "task_run" },
      runId: { type: "string", minLength: 1 },
    }),
    objectSchema({
      kind: { type: "string", const: "previous_summary" },
    }),
  ],
};

const ITEM_SCHEMA = objectSchema({
  text: { type: "string", minLength: 1 },
  sources: arraySchema(SOURCE_SCHEMA, 16, 1),
});

export const SESSION_SNAPSHOT_JSON_SCHEMA: Record<string, unknown> = objectSchema({
  schemaVersion: { type: "integer", const: 1 },
  overview: objectSchema({
    summary: { type: "string", minLength: 1 },
    currentFocus: arraySchema(ITEM_SCHEMA, 16),
    status: { type: "string", enum: ["active", "waiting_for_user", "idle"] },
  }),
  threads: arraySchema(objectSchema({
    subject: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["active", "waiting", "completed", "blocked", "superseded"] },
    latestOutcome: { type: ["string", "null"] },
    next: { type: ["string", "null"] },
    taskIds: arraySchema({ type: "string", minLength: 1 }, 16),
    runIds: arraySchema({ type: "string", minLength: 1 }, 16),
    sources: arraySchema(SOURCE_SCHEMA, 16, 1),
  }), 32),
  userRequests: arraySchema(objectSchema({
    text: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["open", "completed", "blocked", "superseded"] },
    sources: arraySchema(SOURCE_SCHEMA, 16, 1),
  }), 64),
  decisions: arraySchema(ITEM_SCHEMA, 64),
  constraints: arraySchema(ITEM_SCHEMA, 64),
  assistantCommitments: arraySchema(ITEM_SCHEMA, 64),
  unresolvedQuestions: arraySchema(ITEM_SCHEMA, 64),
  importantFacts: arraySchema(ITEM_SCHEMA, 64),
  references: arraySchema(ITEM_SCHEMA, 64),
  recentProgress: arraySchema(objectSchema({
    summary: { type: "string", minLength: 1 },
    taskId: { type: ["string", "null"] },
    runId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["completed", "incomplete", "failed", "blocked", "needs_user_input"] },
    sources: arraySchema(SOURCE_SCHEMA, 16, 1),
  }), 32),
  continuation: objectSchema({
    waitingFor: { type: ["string", "null"] },
    recommendedNext: { type: ["string", "null"] },
    blockers: arraySchema({ type: "string", minLength: 1 }, 32),
  }),
});
